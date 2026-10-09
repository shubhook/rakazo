import type { RakazoDesktop, RakazoDesktopLocalAccount } from "@milo/contracts";

type LocalAccountBridge = NonNullable<RakazoDesktop["localAccount"]>;
type AuthResult = { error: { code?: string; message?: string } | null };

export interface LocalAccountAuth {
  signIn: (account: RakazoDesktopLocalAccount) => Promise<AuthResult>;
  signUp: (account: RakazoDesktopLocalAccount & { name: string }) => Promise<AuthResult>;
  rename: (name: string) => Promise<unknown>;
}

export type LocalAccountResume = "unavailable" | "signed-in" | "needs-name";

/** Signs in with the account the desktop app holds for this server, when it holds one. */
export async function resumeLocalAccount(
  bridge: LocalAccountBridge | undefined,
  auth: LocalAccountAuth,
): Promise<LocalAccountResume> {
  const state = await bridge?.read().catch(() => null);
  if (!state) return "unavailable";
  if (!state.account) return "needs-name";
  const result = await auth.signIn(state.account).catch(() => ({ error: {} }));
  return result.error ? "needs-name" : "signed-in";
}

function alreadyExists(code: string | undefined) {
  return code === "USER_ALREADY_EXISTS" || code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL";
}

/**
 * Creates the account on first run. One an interrupted attempt already created
 * is signed in and given the name instead.
 */
export async function startLocalAccount(
  bridge: LocalAccountBridge,
  name: string,
  auth: LocalAccountAuth,
): Promise<{ ok: true; created: boolean } | { ok: false; message?: string }> {
  const account = await bridge.ensure();
  const created = await auth.signUp({ ...account, name });
  if (!created.error) return { ok: true, created: true };
  if (!alreadyExists(created.error.code)) return { ok: false, message: created.error.message };
  const signedIn = await auth.signIn(account);
  if (signedIn.error) return { ok: false, message: signedIn.error.message };
  await auth.rename(name).catch(() => undefined);
  return { ok: true, created: false };
}
