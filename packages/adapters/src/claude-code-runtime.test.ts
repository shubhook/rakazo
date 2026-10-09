import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  ConnectorTool,
} from "@milo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  ClaudeCodeRoutingRuntime,
  createAgentRuntime,
  runtimeModel,
  runtimeProvidesDefaultModel,
} from "./agent-runtime-factory.js";
import {
  CLAUDE_CODE_SIGNED_OUT_MESSAGE,
  type ClaudeCodeSpawn,
  claudeCodeArgs,
  claudeCodeEffort,
  claudeCodeEnvironment,
  probeClaudeCode,
} from "./claude-code-cli.js";
import { ClaudeCodeAgentRuntime } from "./claude-code-runtime.js";
import { startClaudeCodeToolServer } from "./claude-code-tool-server.js";

const FAKE_CLI = fileURLToPath(new URL("./claude-code-fake-cli.mjs", import.meta.url));

function fakeCli(scenario: string, seen?: { args?: string[]; env?: NodeJS.ProcessEnv }) {
  const fake: ClaudeCodeSpawn = (_command, args, options) => {
    if (seen) {
      seen.args = args;
      seen.env = options.env;
    }
    return spawn(process.execPath, [FAKE_CLI, scenario, ...args], {
      ...options,
      env: { ...options.env, PATH: process.env.PATH },
    });
  };
  return fake;
}

const echoTool: ConnectorTool = {
  name: "echo",
  description: "Echo a word",
  inputSchema: { properties: { word: { type: "string" } }, required: ["word"] },
};

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    botId: "bot-1",
    threadId: "thread-1",
    runId: `run-${Math.random().toString(36).slice(2)}`,
    prompt: "Say hello",
    instructions: "You are a test bot.",
    history: [],
    tools: [echoTool],
    model: { provider: "claude-code", id: "sonnet", thinkingLevel: "high" },
    ...overrides,
  };
}

async function collect(runtime: AgentRuntime, input: AgentRunRequest) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of runtime.run(input)) events.push(event);
  return events;
}

describe("ClaudeCodeAgentRuntime", () => {
  it("streams text, usage, and the final answer", async () => {
    const seen: { args?: string[]; env?: NodeJS.ProcessEnv } = {};
    const runtime = new ClaudeCodeAgentRuntime({
      spawn: fakeCli("text", seen),
      env: { PATH: "/usr/bin", HOME: "/home/test", DATABASE_URL: "postgres://secret" },
    });

    const events = await collect(runtime, request());

    expect(events.filter((event) => event.type === "text").map((event) => event.text)).toEqual([
      "Hello ",
      "there",
    ]);
    expect(events).toContainEqual({
      type: "usage",
      inputTokens: 15,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      provider: "claude-code",
      model: "claude-test-1",
    });
    expect(events.at(-1)).toEqual({ type: "done", text: "Hello there" });
    expect(seen.args).toEqual(expect.arrayContaining(["--model", "sonnet", "--effort", "high"]));
    expect(seen.env?.DATABASE_URL).toBeUndefined();
    expect(seen.env?.HOME).toBe("/home/test");
  });

  it("puts earlier turns before the current message", async () => {
    const runtime = new ClaudeCodeAgentRuntime({ spawn: fakeCli("echo-prompt") });

    const events = await collect(
      runtime,
      request({
        prompt: "What did I say?",
        history: [
          { role: "user", content: "My name is Ada." },
          { role: "assistant", content: "Hi Ada." },
          { role: "user", content: "What did I say?" },
        ],
      }),
    );

    expect(events.at(-1)).toEqual({
      type: "done",
      text: [
        "Earlier conversation, oldest first:",
        "My name is Ada.",
        "Assistant: Hi Ada.",
        "Current message:",
        "What did I say?",
      ].join("\n"),
    });
  });

  it("routes tool calls through the executor over loopback MCP", async () => {
    const executeTool = vi.fn(async () => ({ word: "kiwi!" }));
    const onToolCompleted = vi.fn();
    const runtime = new ClaudeCodeAgentRuntime({ spawn: fakeCli("tool") });

    const events = await collect(
      runtime,
      request({
        tools: [echoTool, { ...echoTool, name: "run_subagent" }],
        executeTool,
        onToolCompleted,
      }),
    );

    expect(executeTool).toHaveBeenCalledWith(
      "echo",
      { word: "kiwi" },
      "toolu_1",
      undefined,
      expect.any(Object),
    );
    expect(events).toContainEqual({
      type: "tool",
      name: "echo",
      args: { word: "kiwi" },
      executionId: "toolu_1",
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      text: 'tools=echo; result={"word":"kiwi!"}',
    });
    expect(onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ name: "echo", executionId: "toolu_1" }),
    );
  });

  it("ends the run when a tool pauses for the person", async () => {
    const runtime = new ClaudeCodeAgentRuntime({ spawn: fakeCli("ask") });

    const events = await collect(runtime, request({ tools: [] }));

    expect(events).toContainEqual({
      type: "ask",
      text: "Which?",
      actions: [
        { id: "choice-1", label: "A" },
        { id: "choice-2", label: "B" },
      ],
    });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("delivers steering at the next turn boundary", async () => {
    const claimSteering = vi
      .fn<NonNullable<AgentRunRequest["claimSteering"]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "s1", messageId: "m2", text: "also this" }])
      .mockResolvedValue([]);
    const runtime = new ClaudeCodeAgentRuntime({ spawn: fakeCli("steer") });

    const events = await collect(runtime, request({ claimSteering }));

    expect(events.at(-1)).toEqual({ type: "done", text: "first then also this" });
    expect(claimSteering).toHaveBeenLastCalledWith(["s1"]);
  });

  it("explains a signed-out CLI without exposing credentials", async () => {
    const runtime = new ClaudeCodeAgentRuntime({ spawn: fakeCli("signed-out") });

    await expect(collect(runtime, request())).rejects.toThrow(CLAUDE_CODE_SIGNED_OUT_MESSAGE);
  });

  it("reports a missing binary", async () => {
    const runtime = new ClaudeCodeAgentRuntime({ binaryPath: "/nonexistent/claude-binary" });

    await expect(collect(runtime, request())).rejects.toThrow(
      "Claude Code is not installed on the machine running Milo.",
    );
  });

  it("stops the CLI on abort", async () => {
    const runtime = new ClaudeCodeAgentRuntime({ spawn: fakeCli("hang") });
    const input = request();
    const run = collect(runtime, input);
    await new Promise((resolve) => setTimeout(resolve, 300));

    await runtime.abort(input.runId);

    await expect(run).resolves.toEqual([{ type: "done" }]);
  });
});

describe("Claude Code CLI boundary", () => {
  it("disables built-in tools, user settings, and other MCP servers", () => {
    const args = claudeCodeArgs({ model: "opus", systemPrompt: "x", mcpConfig: "{}" });

    expect(args).toEqual(
      expect.arrayContaining([
        "--strict-mcp-config",
        "--no-session-persistence",
        "--disable-slash-commands",
      ]),
    );
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual([
      "--tools",
      "",
    ]);
    expect(
      args.slice(args.indexOf("--setting-sources"), args.indexOf("--setting-sources") + 2),
    ).toEqual(["--setting-sources", ""]);
    expect(args.slice(args.indexOf("--allowedTools"), args.indexOf("--allowedTools") + 2)).toEqual([
      "--allowedTools",
      "mcp__rakazo",
    ]);
    expect(
      args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2),
    ).toEqual(["--permission-mode", "dontAsk"]);
  });

  it("passes only the variables the CLI needs", () => {
    const env = claudeCodeEnvironment({
      PATH: "/bin",
      HOME: "/home/a",
      CLAUDE_CONFIG_DIR: "/home/a/.claude-work",
      ANTHROPIC_API_KEY: "sk-ant-placeholder",
      DATABASE_URL: "postgres://placeholder",
      BETTER_AUTH_SECRET: "placeholder",
    });

    expect(env.PATH).toBe(["/bin", join("/home/a", ".local", "bin")].join(delimiter));
    const installerBin = join("/home/a", ".local", "bin");
    expect(claudeCodeEnvironment({ PATH: installerBin, HOME: "/home/a" }).PATH).toBe(installerBin);
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/a/.claude-work");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
  });

  it("maps thinking levels to CLI effort", () => {
    expect(claudeCodeEffort("off")).toBeUndefined();
    expect(claudeCodeEffort(null)).toBeUndefined();
    expect(claudeCodeEffort("minimal")).toBe("low");
    expect(claudeCodeEffort("xhigh")).toBe("xhigh");
  });

  it("probes install and sign-in state", async () => {
    await expect(probeClaudeCode({ spawn: fakeCli("probe") })).resolves.toEqual({
      installed: true,
      version: "2.1.0",
      loggedIn: true,
      authMethod: "claude.ai",
      subscriptionType: "max",
    });
    await expect(probeClaudeCode({ binaryPath: "/nonexistent/claude-binary" })).resolves.toEqual({
      installed: false,
      loggedIn: false,
    });
  });

  it("rejects tool server requests without the run bearer or a loopback host", async () => {
    const call = vi.fn();
    const server = await startClaudeCodeToolServer([echoTool], call);
    try {
      const config = JSON.parse(server.mcpConfig).mcpServers.rakazo as {
        url: string;
        headers: { Authorization: string };
      };
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const headers = { "content-type": "application/json", accept: "application/json" };

      const noBearer = await fetch(config.url, { method: "POST", headers, body });
      const wrongBearer = await fetch(config.url, {
        method: "POST",
        headers: { ...headers, authorization: "Bearer wrong" },
        body,
      });
      const viaLocalhost = await fetch(config.url.replace("127.0.0.1", "localhost"), {
        method: "POST",
        headers: { ...headers, authorization: config.headers.Authorization },
        body,
      });

      expect([noBearer.status, wrongBearer.status, viaLocalhost.status]).toEqual([401, 401, 401]);
      expect(call).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

describe("runtime selection", () => {
  it("routes Claude Code models to the CLI and everything else to Pi", async () => {
    const pi = fakeRuntime("pi");
    const claude = fakeRuntime("claude");
    const runtime = new ClaudeCodeRoutingRuntime(pi, claude);

    await collect(runtime, request());
    await collect(runtime, request({ model: { provider: "openrouter", id: "x/y" } }));

    expect(claude.run).toHaveBeenCalledTimes(1);
    expect(pi.run).toHaveBeenCalledTimes(1);
    expect(runtime.describe().capabilities.model).toEqual({
      provider: "claude-code",
      id: "sonnet",
    });
  });

  it("only gives a keyless default model to runtimes that supply one", () => {
    expect(runtimeProvidesDefaultModel("claude-code")).toBe(true);
    expect(runtimeProvidesDefaultModel("scripted")).toBe(true);
    expect(runtimeProvidesDefaultModel("pi")).toBe(false);
    expect(runtimeModel("claude-code")).toEqual({ provider: "claude-code", id: "sonnet" });
    expect(runtimeModel("pi")).toBeNull();
    expect(createAgentRuntime("pi").describe().capabilities.model).toBeUndefined();
    expect(createAgentRuntime("claude-code").describe().id).toBe("claude-code");
  });
});

function fakeRuntime(id: string) {
  return {
    describe: () => ({
      id,
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
    }),
    run: vi.fn(async function* () {
      yield { type: "done" } as AgentRuntimeEvent;
    }),
    abort: vi.fn(async () => undefined),
  };
}
