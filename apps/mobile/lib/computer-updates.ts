import type { ComputerUpdate } from "@milo/contracts";
import { createComputerUpdates } from "@milo/core";
import { rpc } from "./api";
export const computerUpdates = createComputerUpdates({
  list: () => rpc<ComputerUpdate[]>("computer/updates"),
  start: (botId, action) => rpc<ComputerUpdate>(`computer/${action}`, { botId }),
  releaseInterrupted: (id) => rpc("computer/releaseInterrupted", { id, workersStopped: true }),
  dismiss: (id) => rpc("computer/dismissUpdate", { id }),
});
