import type { AgentRuntimeEvent } from "@milo/adapter-kit";

/**
 * Tools that pause the run for the person instead of reaching the executor.
 * Returns the event to show and the tool result text, or undefined for any other tool.
 */
export function interactiveToolPause(
  name: string,
  args: Record<string, unknown>,
): { event: AgentRuntimeEvent; text: string } | undefined {
  if (name === "request_takeover") {
    return {
      event: { type: "takeover", reason: String(args.reason ?? "I need you on the screen.") },
      text: "Takeover requested.",
    };
  }
  if (name !== "ask_user") return undefined;
  const options = Array.isArray(args.options)
    ? args.options.map((option) => String(option).trim())
    : [];
  if (
    options.length < 2 ||
    options.length > 4 ||
    options.some((option) => option.length === 0 || option.length > 80) ||
    new Set(options).size !== options.length
  ) {
    throw new Error("ask_user requires two to four unique, non-empty options");
  }
  return {
    event: {
      type: "ask",
      text: String(args.question ?? "What should I use?"),
      actions: options.map((label, index) => ({ id: `choice-${index + 1}`, label })),
    },
    text: "Waiting for the user's choice.",
  };
}
