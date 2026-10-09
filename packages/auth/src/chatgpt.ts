import { emailAllowed } from "@milo/core";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import { z } from "zod";

export const CHATGPT_ACCOUNT_PROVIDER = "chatgpt";
/** The client OpenAI issued this browser, reused so a new sign-in does not register Milo again. */
const CLIENT_COOKIE = "chatgpt_client";
const CLIENT_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

export type ChatGptSignInOutcome =
  | { status: "pending" }
  | { status: "error"; error: string }
  | {
      status: "connected";
      identity: { subject: string; email: string; emailVerified: boolean; name?: string };
      clientId: string;
      credential?: unknown;
    };

/** The ChatGPT OAuth flow and plan storage, provided by the composition root. */
export interface ChatGptSignInOptions {
  start(input: { clientId?: string; listen: boolean }): Promise<{ flowId: string; url: string }>;
  complete(
    flowId: string,
    callback?: { code: string; state: string; clientId?: string },
  ): Promise<ChatGptSignInOutcome>;
  /** Stores the plan credential so this person's bots run on their ChatGPT plan. */
  savePlan(userId: string, credential: unknown): Promise<void>;
  signupPolicy(): Promise<{ enabled: boolean; allowlist: string[] }>;
}

const MAX_PENDING = 64;

/**
 * `/chatgpt/start` returns the authorize URL; the page polls `/chatgpt/finish`,
 * passing the callback when it captured one. Started while signed in, the flow
 * links ChatGPT to that account; otherwise it signs in or registers.
 */
export function chatGptSignIn(options: ChatGptSignInOptions): BetterAuthPlugin {
  // Who started each flow, so only that session can finish a link.
  const starters = new Map<string, string | null>();
  return {
    id: "chatgpt",
    endpoints: {
      chatGptStart: createAuthEndpoint(
        "/chatgpt/start",
        { method: "POST", body: z.object({ listen: z.boolean() }) },
        async (ctx) => {
          const session = await getSessionFromCtx(ctx);
          const saved = await ctx.getSignedCookie(CLIENT_COOKIE, ctx.context.secret);
          let started: { flowId: string; url: string };
          try {
            started = await options.start({
              clientId: typeof saved === "string" ? saved : undefined,
              listen: ctx.body.listen,
            });
          } catch (error) {
            throw new APIError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Could not start sign-in",
            });
          }
          if (starters.size >= MAX_PENDING) starters.delete(starters.keys().next().value!);
          starters.set(started.flowId, session?.user.id ?? null);
          return ctx.json(started);
        },
      ),
      chatGptFinish: createAuthEndpoint(
        "/chatgpt/finish",
        {
          method: "POST",
          body: z.object({
            flowId: z.string().min(1).max(128),
            code: z.string().min(1).max(4096).optional(),
            state: z.string().min(1).max(512).optional(),
            clientId: z.string().min(1).max(200).optional(),
          }),
        },
        async (ctx) => {
          const { flowId, code, state, clientId } = ctx.body;
          if (!starters.has(flowId)) {
            return ctx.json({
              status: "error" as const,
              error: "This sign-in expired. Start again.",
            });
          }
          const starter = starters.get(flowId) ?? null;
          const session = starter ? await getSessionFromCtx(ctx) : null;
          if (starter && session?.user.id !== starter) {
            throw new APIError("FORBIDDEN", { message: "Sign in again to connect ChatGPT." });
          }
          const result = await options.complete(
            flowId,
            code && state ? { code, state, clientId } : undefined,
          );
          if (result.status === "pending") return ctx.json(result);
          starters.delete(flowId);
          if (result.status === "error") {
            // A stale registration must not block the next attempt.
            ctx.setCookie(CLIENT_COOKIE, "", { path: "/", maxAge: 0 });
            return ctx.json(result);
          }
          await ctx.setSignedCookie(CLIENT_COOKIE, result.clientId, ctx.context.secret, {
            path: "/",
            httpOnly: true,
            sameSite: "lax",
            maxAge: CLIENT_COOKIE_MAX_AGE,
          });
          const { identity } = result;
          let userId: string;
          let created = false;
          if (starter) {
            const owner = await ctx.context.internalAdapter.findAccountOwnerByKey({
              providerId: CHATGPT_ACCOUNT_PROVIDER,
              accountId: identity.subject,
            });
            if (owner?.kind === "owned" && owner.user.id !== starter) {
              return ctx.json({
                status: "error" as const,
                error: "This ChatGPT account belongs to another Milo account.",
              });
            }
            if (!owner) {
              await ctx.context.internalAdapter.linkAccount({
                providerId: CHATGPT_ACCOUNT_PROVIDER,
                accountId: identity.subject,
                userId: starter,
              });
            }
            userId = starter;
          } else {
            const policy = await options.signupPolicy();
            if (policy.allowlist.length > 0 && !identity.emailVerified) {
              return ctx.json({
                status: "error" as const,
                error: "Verify your ChatGPT email address, then try again.",
              });
            }
            const signedIn = await handleOAuthUserInfo(ctx, {
              userInfo: {
                id: identity.subject,
                email: identity.email,
                emailVerified: identity.emailVerified,
                name: identity.name ?? identity.email.split("@")[0] ?? "User",
                image: null,
              },
              account: { providerId: CHATGPT_ACCOUNT_PROVIDER, accountId: identity.subject },
              disableSignUp: !policy.enabled || !emailAllowed(identity.email, policy.allowlist),
            });
            if (!signedIn.data) {
              return ctx.json({
                status: "error" as const,
                error:
                  signedIn.error === "account not linked"
                    ? "Sign in with your password, then connect ChatGPT."
                    : signedIn.error === "signup disabled"
                      ? "Registration is closed"
                      : "Could not sign in with ChatGPT. Try again.",
              });
            }
            await setSessionCookie(ctx, signedIn.data);
            userId = signedIn.data.user.id;
            created = signedIn.isRegister;
          }
          if (result.credential) {
            try {
              await options.savePlan(userId, result.credential);
            } catch (error) {
              ctx.context.logger.error("Could not store the ChatGPT plan", error);
              // The response still carries the session, so the person stays signed in.
              return ctx.json({
                status: "error" as const,
                error: "Signed in, but could not connect your ChatGPT plan. Try again.",
              });
            }
          }
          return ctx.json({
            status: "connected" as const,
            created,
            plan: Boolean(result.credential),
          });
        },
      ),
    },
    rateLimit: [{ pathMatcher: (path) => path === "/chatgpt/start", window: 15 * 60, max: 10 }],
  } satisfies BetterAuthPlugin;
}
