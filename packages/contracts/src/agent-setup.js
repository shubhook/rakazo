/**
 * The only commands the desktop app runs to set up the agent CLI. The app shows
 * the exact string it runs, and nothing runs until the person presses Run.
 */
const COMMANDS = {
  install: {
    posix: "curl -fsSL https://claude.ai/install.sh | bash",
    win32: "irm https://claude.ai/install.ps1 | iex",
  },
  login: { posix: "claude auth login", win32: "claude auth login" },
};

/** @param {unknown} value */
export function isAgentSetupAction(value) {
  return value === "install" || value === "login";
}

/**
 * @param {"install" | "login"} action
 * @param {string} platform Node `process.platform` of the machine that runs the command.
 */
export function agentSetupCommand(action, platform) {
  return COMMANDS[action][platform === "win32" ? "win32" : "posix"];
}
