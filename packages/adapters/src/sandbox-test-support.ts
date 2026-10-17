import type { AdapterContext, SandboxProvider } from "@milo/adapter-kit";
import type { ComputerEgressPolicy } from "@milo/contracts";

export async function provisionPrepared(
  provider: SandboxProvider,
  request: { botId: string; homePath: string; egress?: ComputerEgressPolicy },
  context: AdapterContext,
) {
  const computer = await provider.provision(request, context);
  await provider.prepare(computer, context);
  return computer;
}
