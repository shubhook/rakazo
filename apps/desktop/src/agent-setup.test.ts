import { spawn } from "node:child_process";
import path from "node:path";
import { agentSetupCommand } from "@milo/contracts/agent-setup";
import { describe, expect, it, vi } from "vitest";
import {
  AgentSetupRunner,
  type AgentSetupSpawn,
  agentSetupEnv,
  agentSetupShell,
} from "./agent-setup.js";

describe("agent setup", () => {
  it("runs only the fixed command through the platform shell", () => {
    expect(agentSetupShell("darwin", agentSetupCommand("install", "darwin"))).toEqual([
      "/bin/sh",
      ["-c", "curl -fsSL https://claude.ai/install.sh | bash"],
    ]);
    expect(agentSetupShell("win32", agentSetupCommand("install", "win32"))).toEqual([
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "irm https://claude.ai/install.ps1 | iex"],
    ]);
    expect(agentSetupCommand("login", "linux")).toBe("claude auth login");
  });

  it("puts the installer's bin on PATH once", () => {
    const bin = path.posix.join("/home/a", ".local", "bin");
    expect(agentSetupEnv("linux", { HOME: "/home/a", PATH: "/usr/bin" }).PATH).toBe(
      `/usr/bin:${bin}`,
    );
    expect(agentSetupEnv("linux", { HOME: "/home/a", PATH: bin }).PATH).toBe(bin);
  });

  it("streams plain output, forwards a prompt answer, and reports the exit code", async () => {
    const seen: { command?: string; args?: string[] } = {};
    // Stand in for the shell with a script that echoes one line of stdin.
    const fake: AgentSetupSpawn = (command, args, options) => {
      seen.command = command;
      seen.args = args;
      return spawn(
        process.execPath,
        [
          "-e",
          "process.stdout.write('\\u001b[32mPaste code\\u001b[0m> ');" +
            "process.stdin.once('data', (d) => { process.stdout.write('got ' + d); process.exit(3); });",
        ],
        { ...options, env: process.env },
      );
    };
    const runner = new AgentSetupRunner({ platform: "linux", env: {}, spawn: fake });
    const output: string[] = [];
    const done = runner.run("login", (text) => {
      output.push(text);
      if (text.includes("Paste code")) runner.input("abc");
    });

    await expect(done).resolves.toEqual({ exitCode: 3 });
    expect(seen).toEqual({ command: "/bin/sh", args: ["-c", "claude auth login"] });
    expect(output.join("")).toBe("Paste code> got abc\n");
  });

  it("allows one command at a time and refuses multi-line input", async () => {
    const child = { stdin: { write: vi.fn() }, stdout: null, stderr: null, on: vi.fn(), pid: 0 };
    const runner = new AgentSetupRunner({
      platform: "linux",
      env: {},
      spawn: (() => child) as unknown as AgentSetupSpawn,
    });
    void runner.run("install", () => {});
    await expect(runner.run("login", () => {})).rejects.toThrow("already running");
    runner.input("a\nrm -rf ~");
    expect(child.stdin.write).not.toHaveBeenCalled();
  });
});
