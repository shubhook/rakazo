import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  AdapterContext,
  AgentInputImage,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentSteeringMessage,
  AgentToolCompletion,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { isToolPauseResult } from "./approval-effect.js";
import { builtinAgentTools } from "./builtin-tools.js";
import {
  CLAUDE_CODE_PROVIDER,
  CLAUDE_CODE_SIGNED_OUT_MESSAGE,
  CLAUDE_CODE_TOOL_SERVER,
  type ClaudeCodeSpawn,
  claudeCodeArgs,
  claudeCodeEffort,
  claudeCodeEnvironment,
  isClaudeCodeSignedOut,
  readJsonLines,
  spawnClaudeCode,
} from "./claude-code-cli.js";
import { type ClaudeCodeToolServer, startClaudeCodeToolServer } from "./claude-code-tool-server.js";
import {
  createQueue,
  describeToolActivity,
  type EventQueue,
  isAgentToolExecutionResult,
  MISSING_TOOL_FINAL_RESPONSE_ERROR,
  sanitizeError,
  summarizeToolResult,
  toHistory,
  withoutSteeringMessages,
} from "./pi-runtime.js";
import { clipToolResultContent } from "./pi-runtime-limits.js";
import { interactiveToolPause } from "./runtime-interactive-tools.js";
import { deliverFinishedShells, type FinishedShellCommand } from "./shell-command-stream.js";

export interface ClaudeCodeAgentRuntimeOptions {
  /** Claude Code executable; defaults to `claude` on PATH. */
  binaryPath?: string;
  /** Environment the CLI login is read from; defaults to the worker's. */
  env?: NodeJS.ProcessEnv;
  spawn?: ClaudeCodeSpawn;
}

type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

// Nested agents are a Pi loop; Claude Code runs its own turn loop instead.
const UNSUPPORTED_TOOLS = new Set(["run_subagent"]);
const KILL_GRACE_MS = 3_000;
const STDERR_TAIL_BYTES = 4_096;

const running = new Map<string, { controller: AbortController; work: Promise<void> }>();

/**
 * Runs a bot turn through the person's own Claude Code CLI. The CLI owns its
 * login (keychain or config dir); Rakazo never sees or stores that credential.
 * Rakazo's tools reach the CLI over a per-run loopback MCP server, and the
 * CLI's built-in tools are disabled, so the executor still owns every effect.
 */
export class ClaudeCodeAgentRuntime implements AgentRuntime {
  constructor(private readonly options: ClaudeCodeAgentRuntimeOptions = {}) {}

  describe() {
    return {
      id: CLAUDE_CODE_PROVIDER,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
    };
  }

  async abort(runId: string): Promise<void> {
    const active = running.get(runId);
    active?.controller.abort();
    await active?.work;
  }

  run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterableIterator<AgentRuntimeEvent> {
    const controller = new AbortController();
    const events = this.runEvents(request, controller, context);
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => events.next(),
      return: () => {
        controller.abort();
        return events.return();
      },
      throw: (error) => {
        controller.abort();
        return events.throw(error);
      },
    };
  }

  private async *runEvents(
    request: AgentRunRequest,
    controller: AbortController,
    context?: Partial<AdapterContext>,
  ): AsyncGenerator<AgentRuntimeEvent, void> {
    const signal = context?.signal
      ? AbortSignal.any([controller.signal, context.signal])
      : controller.signal;
    const queue = createQueue();
    const work = this.execute(request, signal, queue)
      .catch((error: unknown) => {
        queue.fail(
          new Error(sanitizeError(error instanceof Error ? error.message : String(error))),
        );
      })
      .finally(() => queue.close());
    const active = { controller, work };
    running.set(request.runId, active);
    try {
      yield* queue.iterate();
    } finally {
      controller.abort();
      await work;
      if (running.get(request.runId) === active) running.delete(request.runId);
    }
  }

  private async execute(request: AgentRunRequest, signal: AbortSignal, queue: EventQueue) {
    if (signal.aborted) {
      queue.push({ type: "done", text: "stopped" });
      return;
    }
    const tools = (request.tools.length ? request.tools : builtinAgentTools).filter(
      (tool) => !UNSUPPORTED_TOOLS.has(tool.name),
    );
    const state = {
      streamed: "",
      toolCalls: 0,
      toolSeq: 0,
      pausePending: false,
      activityShowing: false,
      pendingShells: [] as Array<Promise<FinishedShellCommand>>,
    };
    let child: ChildProcess | undefined;
    const stop = () => terminate(child);

    const callTool = async (
      name: string,
      args: Record<string, unknown>,
      toolUseId: string | undefined,
    ): Promise<CallToolResult> => {
      if (signal.aborted || state.pausePending) {
        return { content: [{ type: "text", text: "Run stopped." }], isError: true };
      }
      const executionId = toolUseId || `${request.runId}:${name}:${state.toolSeq++}`;
      state.toolCalls += 1;
      state.activityShowing = true;
      queue.push({ type: "tool", name, args, executionId });
      queue.push({ type: "progress", text: describeToolActivity(name, args), activity: true });
      const startedAt = Date.now();
      let result: unknown;
      let failure: unknown;
      try {
        const pause = interactiveToolPause(name, args);
        if (pause) {
          state.pausePending = true;
          queue.push(pause.event);
          return { content: [{ type: "text", text: pause.text }] };
        }
        if (!request.executeTool) {
          return {
            content: [{ type: "text", text: `${name} is unavailable without an executor.` }],
            isError: true,
          };
        }
        const route = tools.find((tool) => tool.name === name)?.route;
        result = await request.executeTool(name, args, executionId, route, {
          onShellStillRunning: (completion) => {
            state.pendingShells.push(completion);
          },
        });
        if (isToolPauseResult(result)) state.pausePending = true;
        return toMcpResult(result);
      } catch (error) {
        failure = error;
        const message = sanitizeError(error instanceof Error ? error.message : String(error));
        return { content: [{ type: "text", text: message }], isError: true };
      } finally {
        const completion: AgentToolCompletion = {
          name,
          executionId,
          durationMs: Math.max(0, Date.now() - startedAt),
          ...(result === undefined ? {} : { result }),
          ...(failure === undefined ? {} : { error: failure }),
          ...(state.pausePending ? { paused: true } : {}),
        };
        try {
          void Promise.resolve(request.onToolCompleted?.(completion)).catch(() => undefined);
        } catch {
          // Audit hooks are best effort and must never change tool behavior.
        }
        // A pause ends this run; the executor resumes the thread in a later run.
        if (state.pausePending) setImmediate(stop);
      }
    };

    const cwd = await mkdtemp(join(tmpdir(), "rakazo-claude-"));
    let server: ClaudeCodeToolServer | undefined;
    try {
      server = await startClaudeCodeToolServer(tools, callTool);
      const seenSteeringIds: string[] = [];
      const initialSteering = request.claimSteering ? await request.claimSteering([]) : [];
      seenSteeringIds.push(...initialSteering.map((item) => item.id));

      child = (this.options.spawn ?? spawnClaudeCode)(
        this.options.binaryPath ?? "claude",
        claudeCodeArgs({
          model: request.model.id,
          effort: claudeCodeEffort(request.model.thinkingLevel),
          systemPrompt: systemPromptFor(request),
          mcpConfig: server.mcpConfig,
        }),
        {
          cwd,
          env: claudeCodeEnvironment(this.options.env ?? process.env),
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
        child!.once("error", (error) => resolve({ code: null, error }));
        child!.once("close", (code) => resolve({ code }));
      });
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
      });
      child.stdin?.on("error", () => undefined);
      signal.addEventListener("abort", stop, { once: true });

      const send = (content: ClaudeContentBlock[]) => {
        child?.stdin?.write(
          `${JSON.stringify({
            type: "user",
            message: { role: "user", content },
            parent_tool_use_id: null,
            session_id: "",
          })}\n`,
        );
      };
      send(initialContent(request, initialSteering));

      let model = request.model.id;
      let sawResult = false;
      let resultError: string | undefined;
      for await (const message of readJsonLines(child.stdout!)) {
        if (message.type === "system" && message.subtype === "init") {
          if (typeof message.model === "string") model = message.model;
          continue;
        }
        if (message.type === "stream_event" && message.parent_tool_use_id == null) {
          const text = textDelta(message.event);
          if (!text) continue;
          if (state.activityShowing) {
            state.activityShowing = false;
            queue.push({ type: "progress", text: "", activity: true });
          }
          state.streamed += text;
          queue.push({ type: "text", text });
          continue;
        }
        if (message.type !== "result") continue;
        sawResult = true;
        const usage = usageFrom(message.usage);
        if (usage) queue.push({ type: "usage", ...usage, provider: CLAUDE_CODE_PROVIDER, model });
        if (message.is_error === true || message.subtype !== "success") {
          resultError = errorTextFrom(message);
          child.stdin?.end();
          continue;
        }
        if (state.pausePending || signal.aborted) {
          child.stdin?.end();
          continue;
        }
        if (state.pendingShells.length) {
          let followUp: string | undefined;
          await deliverFinishedShells(
            (text) => {
              followUp = text;
            },
            state.pendingShells,
            { toolResults: [] },
            signal,
          );
          if (followUp) {
            send([{ type: "text", text: followUp }]);
            continue;
          }
        }
        const steering = request.claimSteering
          ? await request.claimSteering([...seenSteeringIds])
          : [];
        if (steering.length) {
          seenSteeringIds.push(...steering.map((item) => item.id));
          for (const item of steering) send(userContent(item.text, item.images));
          continue;
        }
        child.stdin?.end();
      }

      const exit = await exited;
      signal.removeEventListener("abort", stop);
      if (exit.error) {
        throw new Error(
          (exit.error as NodeJS.ErrnoException).code === "ENOENT"
            ? "Claude Code is not installed on the machine running Rakazo."
            : exit.error.message,
        );
      }
      if (resultError) {
        throw new Error(
          isClaudeCodeSignedOut(resultError) ? CLAUDE_CODE_SIGNED_OUT_MESSAGE : resultError,
        );
      }
      if (!sawResult && !state.pausePending && !signal.aborted) {
        throw new Error(
          isClaudeCodeSignedOut(stderr)
            ? CLAUDE_CODE_SIGNED_OUT_MESSAGE
            : `Claude Code exited before answering (code ${exit.code ?? "signal"}).${
                stderr.trim() ? ` ${stderr.trim().split("\n").slice(-3).join(" ")}` : ""
              }`,
        );
      }

      let streamed = state.streamed;
      if (!streamed.trim() && !state.pausePending && !signal.aborted) {
        if (state.toolCalls > 0 && !request.allowSilentEmpty) {
          throw new Error(MISSING_TOOL_FINAL_RESPONSE_ERROR);
        }
        if (state.toolCalls === 0 && !request.allowSilentEmpty) {
          streamed = request.emptyResponseText?.trim() || "No response. Try again.";
          queue.push({ type: "text", text: streamed });
        }
      }
      queue.push(streamed.trim() ? { type: "done", text: streamed } : { type: "done" });
    } finally {
      signal.removeEventListener("abort", stop);
      terminate(child);
      await server?.close().catch(() => undefined);
      await rm(cwd, { recursive: true, force: true }).catch((error: unknown) => {
        getLogger().warn("Claude Code run directory cleanup failed", { error });
      });
    }
  }
}

function systemPromptFor(request: AgentRunRequest): string {
  const base = request.instructions || "You are a Rakazo bot. Be concise.";
  return `${base}\n\nRakazo tools are available as mcp__${CLAUDE_CODE_TOOL_SERVER}__<tool name>.`;
}

/** Earlier turns become one transcript message; Rakazo stays the source of truth. */
function initialContent(
  request: AgentRunRequest,
  steering: AgentSteeringMessage[],
): ClaudeContentBlock[] {
  const history = toHistory(
    withoutSteeringMessages(request.history, steering),
    request.prompt,
    request.sourceMessageId,
  );
  const blocks: ClaudeContentBlock[] = [];
  if (history.length) {
    blocks.push({ type: "text", text: "Earlier conversation, oldest first:" });
    for (const message of history) {
      if (typeof message.content === "string") {
        blocks.push({ type: "text", text: message.content });
        continue;
      }
      for (const part of message.content) {
        blocks.push(
          part.type === "text"
            ? { type: "text", text: part.text }
            : {
                type: "image",
                source: { type: "base64", media_type: part.mimeType, data: part.data },
              },
        );
      }
    }
    blocks.push({ type: "text", text: "Current message:" });
  }
  const prompt = steering.length
    ? `${request.prompt}\n\nAdditional user context:\n${steering.map((item) => item.text).join("\n")}`
    : request.prompt;
  blocks.push(
    ...userContent(prompt, [
      ...(request.currentTurnImages ?? []),
      ...steering.flatMap((item) => item.images ?? []),
    ]),
  );
  return blocks;
}

function userContent(text: string, images: AgentInputImage[] = []): ClaudeContentBlock[] {
  return [
    { type: "text", text },
    ...images.map((image) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: image.mimeType,
        data: Buffer.from(image.data).toString("base64"),
      },
    })),
  ];
}

function toMcpResult(result: unknown): CallToolResult {
  if (isAgentToolExecutionResult(result)) {
    return {
      content: clipToolResultContent(result.content).map((part) =>
        part.type === "text"
          ? { type: "text" as const, text: part.text }
          : { type: "image" as const, data: part.data, mimeType: part.mimeType },
      ),
    };
  }
  return { content: [{ type: "text", text: summarizeToolResult(result) }] };
}

function textDelta(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const { type, delta } = event as { type?: unknown; delta?: { type?: unknown; text?: unknown } };
  if (type !== "content_block_delta" || delta?.type !== "text_delta") return "";
  return typeof delta.text === "string" ? delta.text : "";
}

function usageFrom(raw: unknown) {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const count = (key: string) => {
    const value = usage[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  };
  const cacheReadTokens = count("cache_read_input_tokens");
  const cacheWriteTokens = count("cache_creation_input_tokens");
  return {
    inputTokens: count("input_tokens") + cacheReadTokens + cacheWriteTokens,
    outputTokens: count("output_tokens"),
    cacheReadTokens,
    cacheWriteTokens,
  };
}

function errorTextFrom(message: Record<string, unknown>): string {
  if (typeof message.result === "string" && message.result.trim()) return message.result.trim();
  if (Array.isArray(message.errors)) {
    const text = message.errors.filter((item) => typeof item === "string").join(" ");
    if (text.trim()) return text.trim();
  }
  return `Claude Code stopped (${String(message.subtype ?? "error")}).`;
}

function terminate(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.stdin?.end();
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, KILL_GRACE_MS).unref();
}
