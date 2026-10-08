import { Trans, useLingui } from "@lingui/react/macro";
import { type AgentSetupAction, type AgentStatus, agentSetupCommand } from "@rakazo/contracts";
import { Button, Input, Spinner } from "@rakazo/ui-web";
import { ArrowRight, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCopyText } from "../lib/copy-text";
import { desktopBridge } from "../lib/desktop";
import { rpc } from "../lib/rpc";

const MAX_OUTPUT_LENGTH = 16 * 1024;
const CODE_PROMPT = /paste code/i;

export function agentReady(status: AgentStatus): boolean {
  return status.installed && status.loggedIn;
}

/**
 * Bots run on the agent CLI on the server's machine. The desktop app can run the
 * install and sign-in commands there; a browser shows them to run by hand.
 */
export function OnboardingAgentStep({
  initialStatus,
  onContinue,
}: {
  initialStatus: AgentStatus;
  onContinue: () => void;
}) {
  const { t } = useLingui();
  const [status, setStatus] = useState(initialStatus);
  const [checking, setChecking] = useState(false);
  const [action, setAction] = useState<AgentSetupAction | null>(null);
  const [canRun, setCanRun] = useState(() => Boolean(desktopBridge()?.agentSetup));
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, copy] = useCopyText();
  const runningRef = useRef(false);
  const ready = agentReady(status);
  const next: AgentSetupAction | null = !status.installed
    ? "install"
    : !status.loggedIn
      ? "login"
      : null;
  const command = action ? agentSetupCommand(action, status.platform) : "";

  async function recheck() {
    setChecking(true);
    try {
      const latest = await rpc.agent.status();
      if (latest) setStatus(latest);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not check Claude Code`);
    } finally {
      setChecking(false);
    }
  }

  // A sign-in finished in the browser or a terminal shows up when the window comes back.
  useEffect(() => {
    const onFocus = () => {
      if (!runningRef.current) void recheck();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    // The step a recheck moved past closes; the next one waits for its own click.
    if (action !== null && action !== next && !running) setAction(null);
  }, [action, next, running]);

  async function run() {
    const setup = desktopBridge()?.agentSetup;
    if (!setup || !action) return;
    setOutput("");
    setCode("");
    setError(null);
    setRunning(true);
    runningRef.current = true;
    const unsubscribe = setup.onOutput((text) =>
      setOutput((current) => (current + text).slice(-MAX_OUTPUT_LENGTH)),
    );
    try {
      const { exitCode } = await setup.run(action);
      if (exitCode !== 0) setError(t`The command stopped before it finished.`);
    } catch (err) {
      // An app pointed at a server on another computer cannot run setup here.
      setCanRun(false);
      setError(err instanceof Error ? err.message : t`Could not run the command`);
    } finally {
      unsubscribe();
      runningRef.current = false;
      setRunning(false);
    }
    await recheck();
  }

  function submitCode() {
    const trimmed = code.trim();
    if (!trimmed) return;
    void desktopBridge()?.agentSetup?.input(trimmed);
    setCode("");
  }

  const statusLabel = checking
    ? t`Checking…`
    : !status.installed
      ? t`Not installed`
      : !status.loggedIn
        ? t`Not signed in`
        : status.version
          ? t`Version ${status.version}`
          : t`Signed in`;

  return (
    <div>
      <h1 className="text-[32px] font-medium text-foreground">
        <Trans>Connect your agent</Trans>
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        <Trans>Milo runs your bots on Claude Code.</Trans>
      </p>
      <div className="mt-8 overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">Claude Code</p>
            <p className="mt-0.5 text-xs text-muted-foreground" aria-live="polite">
              {statusLabel}
            </p>
          </div>
          {checking ? (
            <Spinner className="size-4 text-muted-foreground" />
          ) : ready ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
              <Check className="size-3.5" aria-hidden />
              <Trans>Ready</Trans>
            </span>
          ) : next && action === null ? (
            <Button size="sm" variant="outline" onClick={() => setAction(next)}>
              {next === "install" ? <Trans>Install</Trans> : <Trans>Sign in</Trans>}
            </Button>
          ) : null}
        </div>
        {action !== null && canRun ? (
          <div className="border-t border-border bg-muted">
            <pre className="max-h-64 overflow-auto px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground">
              <span className="text-muted-foreground">$ </span>
              {command}
              {output ? `\n${output}` : ""}
            </pre>
            {running && CODE_PROMPT.test(output) ? (
              <form
                className="flex gap-2 px-4 pb-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitCode();
                }}
              >
                <Input
                  aria-label={t`Sign-in code`}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  autoComplete="off"
                  className="font-mono"
                />
                <Button type="submit" size="sm" variant="outline" disabled={!code.trim()}>
                  <Trans>Submit</Trans>
                </Button>
              </form>
            ) : null}
            <div className="flex justify-end gap-2 border-t border-border px-4 py-2">
              {running ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void desktopBridge()?.agentSetup?.cancel()}
                >
                  <Trans>Cancel</Trans>
                </Button>
              ) : (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setAction(null)}>
                    <Trans>Cancel</Trans>
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void run()}>
                    <Trans>Run</Trans>
                  </Button>
                </>
              )}
            </div>
          </div>
        ) : null}
        {action !== null && !canRun ? (
          <div className="flex items-center gap-2 border-t border-border bg-muted px-4 py-3">
            <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap text-foreground">
              {command}
            </code>
            <Button size="sm" variant="outline" onClick={() => copy(command)}>
              {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
            </Button>
            <Button size="sm" variant="outline" disabled={checking} onClick={() => void recheck()}>
              <Trans>Check again</Trans>
            </Button>
          </div>
        ) : null}
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
      <div className="mt-6 flex justify-end">
        <Button onClick={onContinue} disabled={!ready || checking}>
          <Trans>Continue</Trans>
          <ArrowRight className="size-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
