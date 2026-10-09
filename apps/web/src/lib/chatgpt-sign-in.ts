import { useEffect, useRef, useState } from "react";
import { desktopBridge, oauthStateOf } from "./desktop";

/** Who can catch the 127.0.0.1 redirect: the server itself, only the desktop app, or nobody. */
export type ChatGptCapture = "browser" | "desktop" | null;

export type ChatGptConnected = { created: boolean; plan: boolean };

type FinishResponse =
  | { status: "pending" }
  | { status: "error"; error: string }
  | ({ status: "connected" } & ChatGptConnected);

const POLL_MS = 1_500;
const TIMEOUT_MS = 10 * 60_000;

export function chatGptAvailable(capture: ChatGptCapture | undefined): boolean {
  return capture === "browser" || (capture === "desktop" && Boolean(desktopBridge()?.oauth?.open));
}

async function post<T>(path: string, body: unknown, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api/auth/chatgpt/${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = (await response.json().catch(() => null)) as
    | (T & { message?: string })
    | { message?: string }
    | null;
  if (!response.ok) throw new Error(data?.message ?? "Could not sign in with ChatGPT");
  return data as T;
}

/**
 * Signs in with ChatGPT, or connects it to the signed-in account. The desktop app
 * catches the browser's redirect and hands it over; otherwise the server catches it.
 */
export function useChatGptSignIn(onConnected: (result: ChatGptConnected) => void) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  useEffect(() => () => abortRef.current?.abort(), []);

  async function start() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    setPending(true);
    setError(null);
    const desktop = desktopBridge()?.oauth;
    const capture = desktop?.open ? desktop : null;
    let release: () => void = () => {};
    try {
      const { flowId, url } = await post<{ flowId: string; url: string }>(
        "start",
        { listen: !capture },
        signal,
      );
      let callback: { code: string; state: string; clientId?: string } | null = null;
      if (capture) {
        const expected = oauthStateOf(url);
        release = capture.onCallback((captured) => {
          if (captured.state && captured.state === expected) {
            callback = { code: captured.code, state: captured.state, clientId: captured.clientId };
          }
        });
        signal.addEventListener("abort", () => void capture.cancel?.(url).catch(() => undefined));
        await capture.open?.(url);
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
      const deadline = Date.now() + TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        signal.throwIfAborted();
        const result = await post<FinishResponse>(
          "finish",
          { flowId, ...(callback ?? {}) },
          signal,
        );
        if (result.status === "pending") continue;
        if (result.status === "error") throw new Error(result.error);
        onConnectedRef.current({ created: result.created, plan: result.plan });
        return;
      }
      throw new Error("Sign-in timed out. Try again.");
    } catch (err) {
      if (!signal.aborted) {
        setError(err instanceof Error ? err.message : "Could not sign in with ChatGPT");
      }
    } finally {
      release();
      if (abortRef.current === controller) {
        abortRef.current = null;
        setPending(false);
      }
    }
  }

  function cancel() {
    abortRef.current?.abort();
    abortRef.current = null;
    setPending(false);
  }

  return { start, cancel, pending, error };
}
