import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import {
  CLAUDE_CODE_DEFAULT_MODEL,
  CLAUDE_CODE_PROVIDER,
  type ClaudeCodeSpawn,
} from "./claude-code-cli.js";
import { ClaudeCodeAgentRuntime } from "./claude-code-runtime.js";
import { PiAgentRuntime } from "./pi-runtime.js";
import { ScriptedAgentRuntime } from "./scripted-runtime.js";

/** Bots run on the Claude Code CLI unless AGENT_RUNTIME picks another runtime. */
export const DEFAULT_AGENT_RUNTIME = CLAUDE_CODE_PROVIDER;

/** Runtimes that can run without a stored model credential or deployment key. */
export function runtimeProvidesDefaultModel(kind: string): boolean {
  return kind === "scripted" || runtimeModel(kind) !== null;
}

/**
 * Claude Code runs every bot through the CLI's own sign-in, so people never
 * connect or pick a model.
 */
export function runtimeModel(kind: string): { provider: string; id: string } | null {
  return kind === CLAUDE_CODE_PROVIDER
    ? { provider: CLAUDE_CODE_PROVIDER, id: CLAUDE_CODE_DEFAULT_MODEL }
    : null;
}

export function createAgentRuntime(
  kind: string,
  options: { sessionRoot?: string; claudeCode?: { spawn?: ClaudeCodeSpawn } } = {},
): AgentRuntime {
  if (kind === "scripted") return new ScriptedAgentRuntime();
  const pi = new PiAgentRuntime({ sessionRoot: options.sessionRoot });
  if (kind !== CLAUDE_CODE_PROVIDER) return pi;
  return new ClaudeCodeRoutingRuntime(pi, new ClaudeCodeAgentRuntime(options.claudeCode));
}

/**
 * Bots run through the local Claude Code CLI. Pi still serves models the
 * deployment configures for side work, such as an Auto Review checker.
 */
export class ClaudeCodeRoutingRuntime implements AgentRuntime {
  constructor(
    private readonly pi: AgentRuntime,
    private readonly claudeCode: AgentRuntime,
  ) {}

  describe() {
    const pi = this.pi.describe();
    return {
      ...pi,
      id: CLAUDE_CODE_PROVIDER,
      capabilities: {
        ...pi.capabilities,
        model: { provider: CLAUDE_CODE_PROVIDER, id: CLAUDE_CODE_DEFAULT_MODEL },
      },
    };
  }

  run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    return request.model.provider === CLAUDE_CODE_PROVIDER
      ? this.claudeCode.run(request, context)
      : this.pi.run(request, context);
  }

  async abort(runId: string): Promise<void> {
    await Promise.all([this.pi.abort(runId), this.claudeCode.abort(runId)]);
  }
}
