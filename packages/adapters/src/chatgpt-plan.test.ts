import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { JWK } from "jose";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CHATGPT_PLAN_BASE_URL,
  CHATGPT_PLAN_PROVIDER,
  ChatGptAuth,
  ChatGptSignIn,
  chatGptHostId,
  refreshChatGptPlanCredential,
} from "./chatgpt-plan.js";
import { supplementPiModels } from "./pi-current-models.js";
import { terminalOAuthRefreshErrorMarker } from "./pi-oauth.js";

const ISSUER = "https://auth.openai.com";
let privateKey: CryptoKey;
let jwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "test", alg: "RS256" };
});

function idToken(claims: Record<string, unknown>, audience: string) {
  return new SignJWT({ email: "person@example.com", email_verified: true, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject("user-subject")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

/** A fake OpenAI issuer; `token` answers the token endpoint. */
function fakeIssuer(token: (params: URLSearchParams) => Promise<[number, unknown]>) {
  const requests: URLSearchParams[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return json(200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        jwks_uri: `${ISSUER}/jwks.json`,
      });
    }
    if (url === `${ISSUER}/jwks.json`) return json(200, { keys: [jwk] });
    if (url === `${ISSUER}/oauth/token`) {
      const params = new URLSearchParams(String(init?.body));
      requests.push(params);
      const [status, body] = await token(params);
      return json(status, body);
    }
    return json(404, {});
  }) as typeof fetch;
  return { auth: new ChatGptAuth(fetchImpl), requests };
}

/** Signs an ID token without the attempt's nonce. */
async function grantWithoutNonce(params: URLSearchParams): Promise<[number, unknown]> {
  return [
    200,
    {
      access_token: "access-1",
      refresh_token: "refresh-1",
      id_token: await idToken({}, params.get("client_id") ?? ""),
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid email offline_access chatgpt.tokens.use.direct",
    },
  ];
}

describe("Sign in with ChatGPT", () => {
  it("registers on first sign-in and returns the identity and plan credential", async () => {
    let nonce = "";
    const { auth, requests } = fakeIssuer(async (params) => [
      200,
      {
        access_token: "access-1",
        refresh_token: "refresh-1",
        id_token: await idToken({ nonce }, params.get("client_id") ?? ""),
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid email offline_access resource.invoke chatgpt.tokens.use.direct",
      },
    ]);
    const signIn = new ChatGptSignIn({ hostId: "urn:uuid:host", auth, port: () => 50123 });
    const { flowId, url } = await signIn.start({ listen: false });
    const authorize = new URL(url);
    nonce = authorize.searchParams.get("nonce") ?? "";
    expect(authorize.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(authorize.searchParams.get("agent_name_hint")).toBe("Milo");
    expect(authorize.searchParams.get("ext_agent_host_id")).toBe("urn:uuid:host");
    expect(authorize.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:50123/auth/callback");
    expect(authorize.searchParams.get("resource")).toBe(CHATGPT_PLAN_BASE_URL);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const state = authorize.searchParams.get("state") ?? "";

    expect(await signIn.complete(flowId)).toEqual({ status: "pending" });
    // A callback for another attempt does not consume this one.
    expect(
      await signIn.complete(flowId, { code: "c", state: "other", clientId: "oaiapp_1" }),
    ).toEqual({ status: "pending" });
    const result = await signIn.complete(flowId, { code: "c", state, clientId: "oaiapp_1" });
    expect(result).toMatchObject({
      status: "connected",
      clientId: "oaiapp_1",
      identity: { subject: "user-subject", email: "person@example.com", emailVerified: true },
      credential: {
        access: "access-1",
        refresh: "refresh-1",
        clientId: "oaiapp_1",
        accountId: "user-subject",
      },
    });
    expect(requests[0]?.get("client_id")).toBe("oaiapp_1");
    expect(requests[0]?.get("redirect_uri")).toBe("http://127.0.0.1:50123/auth/callback");
    expect(requests[0]?.get("code_verifier")).toBeTruthy();
    // Results are read once.
    expect((await signIn.complete(flowId)).status).toBe("error");
  });

  it("reuses an issued client and treats a missing one as unfinished registration", async () => {
    const { auth } = fakeIssuer(grantWithoutNonce);
    const signIn = new ChatGptSignIn({ hostId: "h", auth, port: () => 50124 });
    const again = new URL((await signIn.start({ clientId: "oaiapp_1", listen: false })).url);
    expect(again.searchParams.get("client_id")).toBe("oaiapp_1");
    expect(again.searchParams.has("agent_name_hint")).toBe(false);

    const fresh = await signIn.start({ listen: false });
    const state = new URL(fresh.url).searchParams.get("state") ?? "";
    expect(await signIn.complete(fresh.flowId, { code: "c", state })).toEqual({
      status: "error",
      error: "ChatGPT did not finish registering Milo. Try again.",
    });
  });

  it("signs in without a plan credential when plan usage is declined", async () => {
    let nonce = "";
    const { auth } = fakeIssuer(async (params) => [
      200,
      {
        id_token: await idToken({ nonce }, params.get("client_id") ?? ""),
        token_type: "Bearer",
        scope: "openid email profile",
      },
    ]);
    const signIn = new ChatGptSignIn({ hostId: "h", auth, port: () => 50125 });
    const { flowId, url } = await signIn.start({ listen: false });
    nonce = new URL(url).searchParams.get("nonce") ?? "";
    const state = new URL(url).searchParams.get("state") ?? "";
    const result = await signIn.complete(flowId, { code: "c", state, clientId: "oaiapp_1" });
    expect(result).toMatchObject({ status: "connected" });
    expect(result.status === "connected" && result.credential).toBeUndefined();
  });

  it("rejects an ID token for another sign-in", async () => {
    const { auth } = fakeIssuer(grantWithoutNonce);
    const signIn = new ChatGptSignIn({ hostId: "h", auth, port: () => 50126 });
    const { flowId, url } = await signIn.start({ listen: false });
    const state = new URL(url).searchParams.get("state") ?? "";
    expect(await signIn.complete(flowId, { code: "c", state, clientId: "oaiapp_1" })).toEqual({
      status: "error",
      error: "Could not verify the ChatGPT account. Sign in again.",
    });
  });

  it("catches the browser's redirect itself when it runs on the same computer", async () => {
    let nonce = "";
    const { auth } = fakeIssuer(async (params) => [
      200,
      {
        access_token: "a",
        refresh_token: "r",
        id_token: await idToken({ nonce }, params.get("client_id") ?? ""),
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid chatgpt.tokens.use.direct offline_access",
      },
    ]);
    const signIn = new ChatGptSignIn({ hostId: "h", auth });
    const { flowId, url } = await signIn.start({ listen: true });
    const authorize = new URL(url);
    nonce = authorize.searchParams.get("nonce") ?? "";
    const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    redirect.searchParams.set("code", "c");
    redirect.searchParams.set("state", "wrong");
    expect((await fetch(redirect)).status).toBe(400);
    redirect.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    redirect.searchParams.set("client_id", "oaiapp_9");
    const response = await fetch(redirect);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("c&");
    let result = await signIn.complete(flowId);
    for (let i = 0; i < 50 && result.status === "pending"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      result = await signIn.complete(flowId);
    }
    expect(result).toMatchObject({ status: "connected", clientId: "oaiapp_9" });
  });

  it("refreshes the plan and retires it when the grant is gone", async () => {
    const { auth } = fakeIssuer(async (params) =>
      params.get("refresh_token") === "dead"
        ? [400, { error: "invalid_grant" }]
        : [200, { access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }],
    );
    const credential = {
      type: "oauth" as const,
      access: "a",
      refresh: "refresh-1",
      expires: 0,
      clientId: "oaiapp_1",
      accountId: "user-subject",
    };
    await expect(refreshChatGptPlanCredential(credential, undefined, auth)).resolves.toMatchObject({
      access: "access-2",
      refresh: "refresh-2",
      clientId: "oaiapp_1",
      accountId: "user-subject",
    });
    const failure = await refreshChatGptPlanCredential(
      { ...credential, refresh: "dead" },
      undefined,
      auth,
    ).catch((error: unknown) => error);
    expect(terminalOAuthRefreshErrorMarker(failure)).toBe("invalid_grant");
  });

  it("serves plan models through the Responses API without unsupported fields", () => {
    const models = supplementPiModels(builtinModels());
    const plan = models.getProvider(CHATGPT_PLAN_PROVIDER)?.getModels() ?? [];
    expect(plan.length).toBeGreaterThan(0);
    for (const model of plan) {
      expect(model).toMatchObject({
        api: "openai-responses",
        baseUrl: CHATGPT_PLAN_BASE_URL,
        compat: { supportsMaxOutputTokens: false, supportsToolSearch: false },
      });
    }
  });

  it("derives one stable host id per deployment secret", () => {
    expect(chatGptHostId("secret")).toBe(chatGptHostId("secret"));
    expect(chatGptHostId("secret")).not.toBe(chatGptHostId("other"));
    expect(chatGptHostId("secret")).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
