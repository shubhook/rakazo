import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentRunModel } from "@rakazo/adapter-kit";

export const CLAUDE_CODE_PROVIDER = "claude-code";
export const CLAUDE_CODE_DEFAULT_MODEL = "sonnet";
/** MCP server name; the model sees Rakazo tools as `mcp__rakazo__<tool>`. */
export const CLAUDE_CODE_TOOL_SERVER = "rakazo";
export const CLAUDE_CODE_SIGNED_OUT_MESSAGE =
  "Claude Code is not signed in on the machine running Rakazo. Run `claude auth login` there, then try again.";

export type ClaudeCodeSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export const spawnClaudeCode: ClaudeCodeSpawn = (command, args, options) =>
  nodeSpawn(command, args, options);

/**
 * Variables the CLI needs to find its own login and reach the network. Everything
 * else in the worker environment (database URLs, encryption keys, provider keys)
 * stays out of the child. ANTHROPIC_* is dropped so the CLI uses its own login.
 */
const INHERITED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TERM",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "CLAUDE_CONFIG_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SystemRoot",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
] as const;

// Claude Code aborts an HTTP MCP call after 60 s by default; Rakazo shells and
// computer actions legitimately run longer, so the executor's own timeouts end them.
export const CLAUDE_CODE_TOOL_TIMEOUT_MS = 65 * 60 * 1_000;

/**
 * The native installer puts `claude` in `~/.local/bin`, which a GUI launch or a
 * service manager often leaves off PATH; it goes last so a PATH install still wins.
 */
function withInstallerBin(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) return env.PATH;
  const bin = join(home, ".local", "bin");
  const entries = (env.PATH ?? "").split(delimiter).filter(Boolean);
  return entries.includes(bin) ? env.PATH : [...entries, bin].join(delimiter);
}

export function claudeCodeEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_ENV) {
    const value = base[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  env.PATH = withInstallerBin(env);
  return {
    ...env,
    MCP_TOOL_TIMEOUT: String(CLAUDE_CODE_TOOL_TIMEOUT_MS),
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
    CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    DISABLE_AUTOUPDATER: "1",
  };
}

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export function claudeCodeEffort(level: AgentRunModel["thinkingLevel"]): string | undefined {
  if (!level || level === "off") return undefined;
  if (level === "minimal") return "low";
  return EFFORTS.has(level) ? level : undefined;
}

/**
 * Headless flags. Built-in tools are disabled so every effect goes through
 * Rakazo's executor, sandbox, and approvals; user settings, hooks, skills, and
 * other MCP servers stay out of bot runs.
 */
export function claudeCodeArgs(input: {
  model: string;
  effort?: string;
  systemPrompt: string;
  mcpConfig: string;
}): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--settings",
    JSON.stringify({ disableAllHooks: true }),
    "--disable-slash-commands",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    input.mcpConfig,
    "--allowedTools",
    `mcp__${CLAUDE_CODE_TOOL_SERVER}`,
    "--permission-mode",
    "dontAsk",
    "--model",
    input.model,
    ...(input.effort ? ["--effort", input.effort] : []),
    "--system-prompt",
    input.systemPrompt,
  ];
}

const SIGNED_OUT_PATTERN =
  /not logged in|please run \/login|invalid api key|oauth token (has )?(expired|revoked)|authentication_error/i;

export function isClaudeCodeSignedOut(text: string): boolean {
  return SIGNED_OUT_PATTERN.test(text);
}

export async function* readJsonLines(
  stream: NodeJS.ReadableStream,
): AsyncGenerator<Record<string, unknown>> {
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object") yield parsed as Record<string, unknown>;
    } catch {
      // The CLI only writes JSON on stdout in stream-json mode; skip a torn line.
    }
  }
}

export interface ClaudeCodeStatus {
  installed: boolean;
  version?: string;
  loggedIn: boolean;
  authMethod?: string;
  subscriptionType?: string;
}

/** Reads install and sign-in state from the CLI. Never reads or returns a credential. */
export async function probeClaudeCode(
  options: {
    binaryPath?: string;
    env?: NodeJS.ProcessEnv;
    spawn?: ClaudeCodeSpawn;
    timeoutMs?: number;
  } = {},
): Promise<ClaudeCodeStatus> {
  const binary = options.binaryPath ?? "claude";
  const spawn = options.spawn ?? spawnClaudeCode;
  const env = claudeCodeEnvironment(options.env ?? process.env);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const version = await collect(spawn, binary, ["--version"], env, timeoutMs);
  if (version?.code !== 0) return { installed: false, loggedIn: false };
  const installed = {
    installed: true,
    version: version.stdout.trim().split(/\s+/)[0] || undefined,
  };
  const status = await collect(spawn, binary, ["auth", "status", "--json"], env, timeoutMs);
  if (!status) return { ...installed, loggedIn: false };
  try {
    const parsed = JSON.parse(status.stdout) as {
      loggedIn?: unknown;
      authMethod?: unknown;
      subscriptionType?: unknown;
    };
    return {
      ...installed,
      loggedIn: parsed.loggedIn === true,
      ...(typeof parsed.authMethod === "string" ? { authMethod: parsed.authMethod } : {}),
      ...(typeof parsed.subscriptionType === "string"
        ? { subscriptionType: parsed.subscriptionType }
        : {}),
    };
  } catch {
    return { ...installed, loggedIn: false };
  }
}

function collect(
  spawn: ClaudeCodeSpawn,
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string } | undefined> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(undefined);
      return;
    }
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 64 * 1024) stdout += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}
