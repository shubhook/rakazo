// Words a live sandbox uses for a missing binary or file; never evidence that the sandbox is gone.
const SHELL_MISSING_TARGET = /command not found|no such file|^path .* not found/i;

/** Only provider evidence of sandbox loss (a SandboxNotFoundError) permits automatic replacement. */
export function isSandboxGoneError(error: unknown): boolean {
  if (SHELL_MISSING_TARGET.test(error instanceof Error ? error.message : String(error)))
    return false;
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current.name === "SandboxNotFoundError") return true;
  }
  return false;
}
