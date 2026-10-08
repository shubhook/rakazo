import { waitForModelOAuthCompletion } from "@milo/core";
import { rpc } from "./rpc";

export type { ModelCatalogEntry, ModelCredential, ModelOAuthBegin } from "@milo/contracts";
export { cancelModelOAuthAttempt, finishModelOAuthAttempt } from "@milo/core";

export async function waitForModelOAuth(loginId: string, signal?: AbortSignal) {
  return waitForModelOAuthCompletion(() => rpc.models.completeOAuth({ loginId }, { signal }), {
    signal,
  });
}
