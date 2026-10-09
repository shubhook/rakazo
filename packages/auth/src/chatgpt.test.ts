import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it, vi } from "vitest";
import type { ChatGptSignInOptions, ChatGptSignInOutcome } from "./chatgpt.js";
import { chatGptSignIn } from "./chatgpt.js";

const ORIGIN = "http://127.0.0.1:3100";

function setup(
  options: {
    policy?: { enabled: boolean; allowlist: string[] };
    outcome?: ChatGptSignInOutcome;
  } = {},
) {
  const savePlan = vi.fn(async () => undefined);
  const start = vi.fn(async () => ({
    flowId: `flow-${start.mock.calls.length}`,
    url: "https://auth.openai.com/authorize",
  }));
  const signIn: ChatGptSignInOptions = {
    start,
    complete: vi.fn(
      async (_flowId, callback) =>
        options.outcome ??
        (callback
          ? {
              status: "connected" as const,
              identity: {
                subject: "chatgpt-subject",
                email: "person@example.com",
                emailVerified: true,
                name: "Person",
              },
              clientId: "oaiapp_1",
              credential: { access: "a" },
            }
          : { status: "pending" as const }),
    ),
    savePlan,
    signupPolicy: async () => options.policy ?? { enabled: true, allowlist: [] },
  };
  const auth = betterAuth({
    secret: "test-secret-that-is-long-enough-for-better-auth",
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    emailAndPassword: { enabled: true },
    plugins: [chatGptSignIn(signIn)],
  });
  async function post(path: string, body: unknown, cookie?: string) {
    return auth.handler(
      new Request(`${ORIGIN}/api/auth${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  }
  return { auth, post, savePlan, start };
}

function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

describe("Sign in with ChatGPT", () => {
  it("registers, signs in and stores the plan for the new account", async () => {
    const { auth, post, savePlan } = setup();
    const started = await post("/chatgpt/start", { listen: false });
    const { flowId } = (await started.json()) as { flowId: string };
    expect(await (await post("/chatgpt/finish", { flowId })).json()).toEqual({ status: "pending" });

    const finished = await post("/chatgpt/finish", { flowId, code: "c", state: "s" });
    expect(await finished.clone().json()).toEqual({
      status: "connected",
      created: true,
      plan: true,
    });
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookies(finished) }),
    });
    expect(session?.user.email).toBe("person@example.com");
    expect(savePlan).toHaveBeenCalledWith(session?.user.id, { access: "a" });
  });

  it("reuses the issued client on the next sign-in from this browser", async () => {
    const { post, start } = setup();
    const { flowId } = (await (await post("/chatgpt/start", { listen: true })).json()) as {
      flowId: string;
    };
    const finished = await post("/chatgpt/finish", { flowId, code: "c", state: "s" });
    await post("/chatgpt/start", { listen: true }, cookies(finished));
    expect(start).toHaveBeenLastCalledWith({ clientId: "oaiapp_1", listen: true });
  });

  it("keeps registration closed to new ChatGPT accounts", async () => {
    const { post, savePlan } = setup({ policy: { enabled: false, allowlist: [] } });
    const { flowId } = (await (await post("/chatgpt/start", { listen: false })).json()) as {
      flowId: string;
    };
    const finished = await post("/chatgpt/finish", { flowId, code: "c", state: "s" });
    expect(await finished.json()).toEqual({ status: "error", error: "Registration is closed" });
    expect(savePlan).not.toHaveBeenCalled();
  });

  it("links ChatGPT to the account that started the flow", async () => {
    const { auth, post, savePlan } = setup();
    const signedUp = await auth.api.signUpEmail({
      body: { email: "owner@example.com", password: "a-long-password", name: "Owner" },
      asResponse: true,
    });
    const session = cookies(signedUp);
    const { flowId } = (await (
      await post("/chatgpt/start", { listen: false }, session)
    ).json()) as {
      flowId: string;
    };
    // Another browser cannot finish a link it did not start.
    expect((await post("/chatgpt/finish", { flowId, code: "c", state: "s" })).status).toBe(403);

    const finished = await post("/chatgpt/finish", { flowId, code: "c", state: "s" }, session);
    expect(await finished.json()).toEqual({ status: "connected", created: false, plan: true });
    const owner = await auth.api.getSession({ headers: new Headers({ cookie: session }) });
    expect(savePlan).toHaveBeenCalledWith(owner?.user.id, { access: "a" });
    const accounts = await auth.api.listUserAccounts({ headers: new Headers({ cookie: session }) });
    expect(accounts.map((account) => account.providerId)).toContain("chatgpt");
  });

  it("reports an unknown or finished flow as expired", async () => {
    const { post } = setup();
    expect(await (await post("/chatgpt/finish", { flowId: "missing" })).json()).toEqual({
      status: "error",
      error: "This sign-in expired. Start again.",
    });
  });
});
