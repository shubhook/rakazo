import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type AgentSetupAction, agentSetupCommand } from "@milo/contracts/agent-setup";
import { killProcessTree } from "./docker-cli.js";

const RUN_TIMEOUT_MS = 15 * 60_000;
const MAX_INPUT_LENGTH = 4096;

export type AgentSetupSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

/** The platform shell runs the fixed command string, so the renderer shows exactly what runs. */
export function agentSetupShell(platform: string, command: string): [string, string[]] {
  return platform === "win32"
    ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]]
    : ["/bin/sh", ["-c", command]];
}

/** Adds the native installer's bin, which a GUI launch usually leaves off PATH, so sign-in finds `claude` right after install. */
export function agentSetupEnv(platform: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = platform === "win32" ? env.USERPROFILE : env.HOME;
  if (!home) return env;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const bin = paths.join(home, ".local", "bin");
  const entries = (env.PATH ?? "").split(paths.delimiter).filter(Boolean);
  return entries.includes(bin) ? env : { ...env, PATH: [...entries, bin].join(paths.delimiter) };
}

/** Runs one agent setup command at a time for the app window and streams its output. */
export class AgentSetupRunner {
  private child: ChildProcess | null = null;

  constructor(
    private readonly deps: {
      platform: string;
      env: NodeJS.ProcessEnv;
      spawn?: AgentSetupSpawn;
    },
  ) {}

  run(action: AgentSetupAction, onOutput: (text: string) => void): Promise<{ exitCode: number }> {
    if (this.child) return Promise.reject(new Error("A setup command is already running."));
    const [shell, args] = agentSetupShell(
      this.deps.platform,
      agentSetupCommand(action, this.deps.platform),
    );
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = (this.deps.spawn ?? nodeSpawn)(shell, args, {
          env: agentSetupEnv(this.deps.platform, this.deps.env),
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          detached: this.deps.platform !== "win32",
        });
      } catch (error) {
        onOutput(error instanceof Error ? error.message : String(error));
        resolve({ exitCode: 1 });
        return;
      }
      this.child = child;
      const timer = setTimeout(() => this.cancel(), RUN_TIMEOUT_MS);
      timer.unref?.();
      for (const stream of [child.stdout, child.stderr]) {
        stream?.setEncoding("utf8");
        stream?.on("data", (chunk: string) => {
          // Colors and cursor moves from the installer and CLI; the renderer shows plain text.
          const text = stripVTControlCharacters(chunk);
          if (text) onOutput(text);
        });
      }
      let settled = false;
      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.child === child) this.child = null;
        resolve({ exitCode });
      };
      child.on("error", (error) => {
        onOutput(error.message);
        finish(1);
      });
      child.on("close", (code) => finish(code ?? 1));
    });
  }

  /** Answers a prompt from the running command, such as the sign-in code. */
  input(line: string): void {
    if (line.length > MAX_INPUT_LENGTH || /[\r\n]/.test(line)) return;
    this.child?.stdin?.write(`${line}\n`);
  }

  cancel(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    killProcessTree(child.pid);
  }
}
