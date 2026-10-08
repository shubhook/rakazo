import type { RakazoDesktopLocalAccount } from "@milo/contracts";
import { describe, expect, it, vi } from "vitest";
import { type LocalAccountAuth, resumeLocalAccount, startLocalAccount } from "./local-account";

const account: RakazoDesktopLocalAccount = {
  email: "0a0a0a@desktop.rakazo.invalid",
  password: "a-long-random-password",
};

function bridge(saved: RakazoDesktopLocalAccount | null | "unavailable") {
  return {
    read: vi.fn(async () => (saved === "unavailable" ? null : { account: saved })),
    ensure: vi.fn(async () => account),
  };
}

function auth(overrides: Partial<LocalAccountAuth> = {}): LocalAccountAuth {
  return {
    signIn: vi.fn(async () => ({ error: null })),
    signUp: vi.fn(async () => ({ error: null })),
    rename: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("resumeLocalAccount", () => {
  it("falls back when the app holds no account for this server", async () => {
    expect(await resumeLocalAccount(undefined, auth())).toBe("unavailable");
    expect(await resumeLocalAccount(bridge("unavailable"), auth())).toBe("unavailable");
    const failing = { read: vi.fn(async () => Promise.reject(new Error("ipc"))), ensure: vi.fn() };
    expect(await resumeLocalAccount(failing, auth())).toBe("unavailable");
  });

  it("asks for a name before the first account exists", async () => {
    const signIn = vi.fn(async () => ({ error: null }));
    expect(await resumeLocalAccount(bridge(null), auth({ signIn }))).toBe("needs-name");
    expect(signIn).not.toHaveBeenCalled();
  });

  it("signs in with the saved account", async () => {
    const signIn = vi.fn(async () => ({ error: null }));
    expect(await resumeLocalAccount(bridge(account), auth({ signIn }))).toBe("signed-in");
    expect(signIn).toHaveBeenCalledWith(account);
  });

  it("asks for a name again when the server no longer knows the account", async () => {
    const signIn = vi.fn(async () => ({ error: { code: "INVALID_EMAIL_OR_PASSWORD" } }));
    expect(await resumeLocalAccount(bridge(account), auth({ signIn }))).toBe("needs-name");
  });
});

describe("startLocalAccount", () => {
  it("creates the account with the name", async () => {
    const signUp = vi.fn(async () => ({ error: null }));
    expect(await startLocalAccount(bridge(null), "Ada", auth({ signUp }))).toEqual({
      ok: true,
      created: true,
    });
    expect(signUp).toHaveBeenCalledWith({ ...account, name: "Ada" });
  });

  it("signs in and renames an account an earlier attempt created", async () => {
    const rename = vi.fn(async () => undefined);
    const signIn = vi.fn(async () => ({ error: null }));
    const signUp = vi.fn(async () => ({ error: { code: "USER_ALREADY_EXISTS" } }));
    expect(
      await startLocalAccount(bridge(account), "Ada", auth({ signIn, signUp, rename })),
    ).toEqual({ ok: true, created: false });
    expect(signIn).toHaveBeenCalledWith(account);
    expect(rename).toHaveBeenCalledWith("Ada");
  });

  it("reports what the server refused", async () => {
    const signUp = vi.fn(async () => ({ error: { message: "Registration is closed" } }));
    expect(await startLocalAccount(bridge(null), "Ada", auth({ signUp }))).toEqual({
      ok: false,
      message: "Registration is closed",
    });
  });
});
