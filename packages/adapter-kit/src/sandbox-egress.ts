import type { ComputerEgressPolicy } from "@milo/contracts";
import type { SandboxProvider } from "./interfaces.js";

export class EgressUnsupportedError extends Error {
  constructor(providerId: string) {
    super(`The ${providerId} computer provider cannot restrict network access`);
    this.name = "EgressUnsupportedError";
  }
}

/** Fail closed: a provider that cannot enforce a restricted policy must not boot under it. */
export function assertSandboxEgress(
  provider: Pick<SandboxProvider, "describe">,
  policy: ComputerEgressPolicy | undefined,
): void {
  if (policy?.mode !== "restricted") return;
  const descriptor = provider.describe();
  if (descriptor.capabilities.egress !== true) throw new EgressUnsupportedError(descriptor.id);
}
