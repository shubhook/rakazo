import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { Api, Model, MutableModels, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { JSONWebKeySet } from "jose";
import { createLocalJWKSet, jwtVerify } from "jose";

/**
 * Sign in with ChatGPT: one OAuth sign-in returns a verified ChatGPT identity and,
 * when the person allows it, a token that runs models on their ChatGPT plan
 * through the public Responses API. OpenAI only redirects to a 127.0.0.1
 * callback, so it works when the browser and the callback listener share a computer.
 */
export const CHATGPT_PLAN_PROVIDER = "chatgpt";
export const CHATGPT_PLAN_BASE_URL = "https://api.openai.com/v1";
/** Used until the person picks another model; the plan serves every Codex model. */
export const CHATGPT_PLAN_DEFAULT_MODEL = "gpt-6-sol";

const ISSUER = "https://auth.openai.com";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const REGISTRATION_CLIENT = "dynamic_agent_client";
const CALLBACK_PATH = "/auth/callback";
const APP_NAME = "Milo";
const FLOW_TTL_MS = 10 * 60_000;
const MAX_FLOWS = 8;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const JWKS_TTL_MS = 10 * 60_000;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

type Fetch = typeof fetch;

/** The plan credential. `accountId` is the ChatGPT subject, so a refresh for another account retires it. */
export type ChatGptPlanCredential = OAuthCredential & { clientId: string; accountId: string };

export type ChatGptIdentity = {
  subject: string;
  email: string;
  emailVerified: boolean;
  name?: string;
};

export type ChatGptSignInResult =
  | { status: "pending" }
  | { status: "error"; error: string }
  | {
      status: "connected";
      identity: ChatGptIdentity;
      clientId: string;
      /** Missing when the person declined plan usage; identity alone still signs in. */
      credential?: ChatGptPlanCredential;
    };

export type ChatGptCallback = { code: string; state: string; clientId?: string };

type Discovery = { authorization_endpoint: string; token_endpoint: string; jwks_uri: string };

type Flow = {
  id: string;
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  /** The issued client this browser registered before, or undefined to register. */
  clientId?: string;
  server?: Server;
  timer: ReturnType<typeof setTimeout>;
  completing?: Promise<ChatGptSignInResult>;
};

class ChatGptError extends Error {}

const random = () => randomBytes(32).toString("base64url");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One stable, opaque host id per deployment, derived so nothing new needs storing. */
export function chatGptHostId(secret: string): string {
  const hex = createHmac("sha256", secret).update("chatgpt-agent-host").digest("hex");
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export class ChatGptAuth {
  private discovery?: Promise<Discovery>;
  private jwks?: { keys: ReturnType<typeof createLocalJWKSet>; expires: number };

  constructor(private readonly fetchImpl: Fetch = fetch) {}

  private async json(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
    const response = await this.fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(init?.signal ? [init.signal] : []),
      ]),
    });
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new ChatGptError("ChatGPT sent too much data.");
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  }

  endpoints(): Promise<Discovery> {
    this.discovery ??= (async () => {
      const { status, body } = await this.json(`${ISSUER}/.well-known/openid-configuration`);
      if (status !== 200 || !isRecord(body) || body.issuer !== ISSUER) {
        throw new ChatGptError("Could not reach ChatGPT sign-in. Try again.");
      }
      for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
        const value = body[key];
        if (typeof value !== "string" || !URL.canParse(value) || new URL(value).origin !== ISSUER) {
          throw new ChatGptError("Could not reach ChatGPT sign-in. Try again.");
        }
      }
      return body as unknown as Discovery;
    })().catch((error: unknown) => {
      this.discovery = undefined;
      throw error;
    });
    return this.discovery;
  }

  private async keySet() {
    if (this.jwks && this.jwks.expires > Date.now()) return this.jwks.keys;
    const { jwks_uri } = await this.endpoints();
    const { status, body } = await this.json(jwks_uri);
    if (status !== 200 || !isRecord(body) || !Array.isArray(body.keys)) {
      throw new ChatGptError("Could not verify the ChatGPT account. Try again.");
    }
    const keys = createLocalJWKSet(body as unknown as JSONWebKeySet);
    this.jwks = { keys, expires: Date.now() + JWKS_TTL_MS };
    return keys;
  }

  /** Checks the ID token's signature, issuer, audience, expiry and nonce. */
  async verifyIdentity(
    idToken: string,
    clientId: string,
    nonce?: string,
  ): Promise<ChatGptIdentity> {
    const keys = await this.keySet();
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(idToken, keys, {
        issuer: ISSUER,
        audience: clientId,
        algorithms: ["RS256"],
        clockTolerance: 5,
        requiredClaims: ["iss", "aud", "exp", "iat", "sub"],
      }));
    } catch {
      throw new ChatGptError("Could not verify the ChatGPT account. Sign in again.");
    }
    if (
      typeof payload.sub !== "string" ||
      !payload.sub ||
      (nonce !== undefined && payload.nonce !== nonce) ||
      (payload.azp !== undefined && payload.azp !== clientId)
    ) {
      throw new ChatGptError("Could not verify the ChatGPT account. Sign in again.");
    }
    if (typeof payload.email !== "string" || !payload.email.includes("@")) {
      throw new ChatGptError("ChatGPT did not share an email address.");
    }
    return {
      subject: payload.sub,
      email: payload.email.toLowerCase(),
      emailVerified: payload.email_verified === true,
      ...(typeof payload.name === "string" && payload.name.trim() ? { name: payload.name } : {}),
    };
  }

  async token(params: Record<string, string>, signal?: AbortSignal) {
    const { token_endpoint } = await this.endpoints();
    const { status, body } = await this.json(token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ ...params, resource: CHATGPT_PLAN_BASE_URL }),
      signal,
    });
    if (status !== 200 || !isRecord(body)) {
      const code = isRecord(body) && typeof body.error === "string" ? body.error : "unknown_error";
      // The status and OAuth error code let a terminal refresh retire the credential.
      throw new ChatGptError(`ChatGPT token request failed (${status}): ${code}`);
    }
    return body;
  }
}

/** Shares discovery and signing keys across sign-ins and refreshes. */
const sharedAuth = new ChatGptAuth();

function planCredential(
  body: Record<string, unknown>,
  clientId: string,
  accountId: string,
  previousRefresh?: string,
): ChatGptPlanCredential | undefined {
  const scopes = typeof body.scope === "string" ? body.scope.split(/\s+/) : [];
  if (!scopes.includes(PLAN_SCOPE)) return undefined;
  const refresh = typeof body.refresh_token === "string" ? body.refresh_token : previousRefresh;
  if (
    typeof body.access_token !== "string" ||
    !body.access_token ||
    typeof body.expires_in !== "number" ||
    body.expires_in <= 0 ||
    !refresh
  ) {
    throw new ChatGptError("ChatGPT returned incomplete credentials. Sign in again.");
  }
  return {
    type: "oauth",
    access: body.access_token,
    refresh,
    expires: Date.now() + body.expires_in * 1000,
    clientId,
    accountId,
  };
}

/**
 * Pending sign-ins, keyed by an unguessable id only the starting page holds.
 * The page delivers the callback itself (the desktop app captures it), or this
 * server listens on the loopback callback when it runs on the browser's computer.
 */
export class ChatGptSignIn {
  private readonly flows = new Map<string, Flow>();
  private readonly auth: ChatGptAuth;

  constructor(
    private readonly options: {
      hostId: string;
      auth?: ChatGptAuth;
      /** Picks the redirect port when the caller captures the callback. */
      port?: () => number;
    },
  ) {
    this.auth = options.auth ?? sharedAuth;
  }

  async start(input: {
    clientId?: string;
    listen: boolean;
  }): Promise<{ flowId: string; url: string }> {
    if (this.flows.size >= MAX_FLOWS) {
      throw new ChatGptError("Too many sign-ins are in progress. Try again in a few minutes.");
    }
    const clientId =
      input.clientId &&
      CLIENT_ID_PATTERN.test(input.clientId) &&
      input.clientId !== REGISTRATION_CLIENT
        ? input.clientId
        : undefined;
    const { authorization_endpoint } = await this.auth.endpoints();
    const flow: Flow = {
      id: random(),
      state: random(),
      nonce: random(),
      verifier: random(),
      redirectUri: "",
      clientId,
      timer: setTimeout(() => this.cancel(flow.id), FLOW_TTL_MS),
    };
    flow.timer.unref?.();
    let port = (this.options.port ?? (() => 49152 + Math.floor(Math.random() * 16_000)))();
    if (input.listen) {
      try {
        flow.server = await this.listen(flow);
      } catch (error) {
        clearTimeout(flow.timer);
        throw error;
      }
      const address = flow.server.address();
      if (address && typeof address !== "string") port = address.port;
    }
    flow.redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    this.flows.set(flow.id, flow);
    const url = new URL(authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: clientId ?? REGISTRATION_CLIENT,
      response_type: "code",
      redirect_uri: flow.redirectUri,
      scope: SCOPES,
      resource: CHATGPT_PLAN_BASE_URL,
      state: flow.state,
      nonce: flow.nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(flow.verifier).digest("base64url"),
      ext_agent_host_id: this.options.hostId,
      ...(clientId ? {} : { agent_name_hint: APP_NAME }),
    }).toString();
    return { flowId: flow.id, url: url.href };
  }

  /** Reports the sign-in, finishing it with a callback the page captured. Results are read once. */
  async complete(flowId: string, callback?: ChatGptCallback): Promise<ChatGptSignInResult> {
    const flow = this.flows.get(flowId);
    if (!flow) return { status: "error", error: "This sign-in expired. Start again." };
    const result = callback
      ? await this.finish(flow, callback)
      : ((await flow.completing) ?? { status: "pending" as const });
    if (result.status !== "pending") this.cancel(flowId);
    return result;
  }

  private async finish(flow: Flow, callback: ChatGptCallback): Promise<ChatGptSignInResult> {
    flow.completing ??= this.exchange(flow, callback);
    const result = await flow.completing;
    // A callback for another attempt leaves this one open for the right one.
    if (result.status === "pending") flow.completing = undefined;
    return result;
  }

  cancel(flowId: string): void {
    const flow = this.flows.get(flowId);
    if (!flow) return;
    this.flows.delete(flowId);
    clearTimeout(flow.timer);
    flow.server?.close();
    flow.server?.closeAllConnections();
  }

  cancelAll(): void {
    for (const id of [...this.flows.keys()]) this.cancel(id);
  }

  private async exchange(flow: Flow, callback: ChatGptCallback): Promise<ChatGptSignInResult> {
    const returned = Buffer.from(callback.state);
    const expected = Buffer.from(flow.state);
    if (returned.length !== expected.length || !timingSafeEqual(returned, expected)) {
      return { status: "pending" };
    }
    const clientId = callback.clientId ?? flow.clientId;
    if (
      !clientId ||
      !CLIENT_ID_PATTERN.test(clientId) ||
      clientId === REGISTRATION_CLIENT ||
      (flow.clientId !== undefined &&
        callback.clientId !== undefined &&
        callback.clientId !== flow.clientId)
    ) {
      return { status: "error", error: "ChatGPT did not finish registering Milo. Try again." };
    }
    try {
      const body = await this.auth.token({
        grant_type: "authorization_code",
        client_id: clientId,
        code: callback.code,
        code_verifier: flow.verifier,
        redirect_uri: flow.redirectUri,
      });
      if (typeof body.id_token !== "string") {
        throw new ChatGptError("Could not verify the ChatGPT account. Sign in again.");
      }
      const identity = await this.auth.verifyIdentity(body.id_token, clientId, flow.nonce);
      return {
        status: "connected",
        identity,
        clientId,
        credential: planCredential(body, clientId, identity.subject),
      };
    } catch (error) {
      return {
        status: "error",
        error:
          error instanceof ChatGptError && !error.message.includes("token request failed")
            ? error.message
            : "Could not finish signing in with ChatGPT. Try again.",
      };
    }
  }

  private listen(flow: Flow): Promise<Server> {
    const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
      const address = server.address();
      const origin =
        address && typeof address !== "string" ? `http://127.0.0.1:${address.port}` : "";
      const url = URL.canParse(request.url ?? "/", origin)
        ? new URL(request.url ?? "/", origin)
        : null;
      const code = url?.searchParams.get("code");
      const state = url?.searchParams.get("state");
      const clientId = url?.searchParams.get("client_id") ?? undefined;
      if (
        !url ||
        request.method !== "GET" ||
        request.headers.host !== new URL(origin).host ||
        url.pathname !== CALLBACK_PATH ||
        url.searchParams.getAll("state").length !== 1 ||
        url.searchParams.getAll("code").length !== 1 ||
        url.searchParams.getAll("client_id").length > 1 ||
        !code ||
        !state ||
        state !== flow.state
      ) {
        response.writeHead(400).end("Sign-in callback rejected. Return to Milo to retry.");
        return;
      }
      response.end("You can close this tab and return to Milo.", () => server.close());
      // The page reads the outcome with its next poll.
      void this.finish(flow, { code, state, clientId });
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    return new Promise((resolve, reject) => {
      server.once("error", () =>
        reject(new ChatGptError("Could not listen for the ChatGPT sign-in. Try again.")),
      );
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
  }
}

/** Exchanges the refresh token; a new ID token must name the same ChatGPT account. */
export async function refreshChatGptPlanCredential(
  credential: OAuthCredential,
  signal?: AbortSignal,
  auth: ChatGptAuth = sharedAuth,
): Promise<ChatGptPlanCredential> {
  const clientId = typeof credential.clientId === "string" ? credential.clientId : "";
  const accountId = typeof credential.accountId === "string" ? credential.accountId : "";
  if (!clientId || !accountId) {
    throw new ChatGptError("ChatGPT token request failed (400): invalid_grant");
  }
  const body = await auth.token(
    { grant_type: "refresh_token", client_id: clientId, refresh_token: credential.refresh },
    signal,
  );
  const subject =
    typeof body.id_token === "string"
      ? (await auth.verifyIdentity(body.id_token, clientId)).subject
      : accountId;
  // A different subject fails the runtime's account check and retires the credential.
  const next = planCredential(
    { scope: PLAN_SCOPE, ...body },
    clientId,
    subject,
    credential.refresh,
  );
  if (!next) throw new ChatGptError("ChatGPT token request failed (400): invalid_grant");
  return next;
}

/**
 * The plan serves the Codex catalog through the public Responses API, which
 * only accepts stored-off, streamed requests without output caps or tool search.
 */
function planModel(model: Model<Api>): Model<"openai-responses"> {
  return {
    ...model,
    api: "openai-responses",
    provider: CHATGPT_PLAN_PROVIDER,
    baseUrl: CHATGPT_PLAN_BASE_URL,
    compat: {
      ...(model.compat as Model<"openai-responses">["compat"]),
      supportsMaxOutputTokens: false,
      supportsLongCacheRetention: false,
      supportsToolSearch: false,
    },
  };
}

export function chatGptPlanProvider(models: MutableModels): Provider | undefined {
  const codex = models.getProvider("openai-codex");
  if (!codex) return undefined;
  return createProvider({
    id: CHATGPT_PLAN_PROVIDER,
    name: "ChatGPT",
    baseUrl: CHATGPT_PLAN_BASE_URL,
    auth: {
      oauth: {
        name: "ChatGPT",
        isSubscription: true,
        login: async () => {
          throw new Error("Use Sign in with ChatGPT.");
        },
        refresh: (credential, signal) => refreshChatGptPlanCredential(credential, signal),
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
    models: codex.getModels().map(planModel),
    api: openAIResponsesApi(),
  });
}
