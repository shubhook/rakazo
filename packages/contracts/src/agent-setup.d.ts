export type AgentSetupAction = "install" | "login";
export function isAgentSetupAction(value: unknown): value is AgentSetupAction;
export function agentSetupCommand(action: AgentSetupAction, platform: string): string;
