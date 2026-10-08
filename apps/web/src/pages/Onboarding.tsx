import { Trans, useLingui } from "@lingui/react/macro";
import type { AgentStatus, IntegrationSetupState } from "@milo/contracts";
import { Button } from "@milo/ui-web";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { IntegrationSetup } from "../components/integrations/IntegrationSetup";
import { rpc } from "../lib/rpc";
import { agentReady, OnboardingAgentStep } from "./OnboardingAgent";

const FIRST_BOT_NAME = "Chief";
const FIRST_BOT_SPAWN_KEY = "onboarding:first";
const FIRST_BOT_LOCK = "rakazo:onboarding-first-bot";

/** Survives StrictMode remounts; concurrent first-bot creates share one in-flight attempt. */
let firstBotEnsure: Promise<{ id: string }> | null = null;

function findFirstBot(
  bots: Array<{ id: string; name: string; spawnKey: string | null }>,
): { id: string } | undefined {
  const bySpawnKey = bots.find((bot) => bot.spawnKey === FIRST_BOT_SPAWN_KEY);
  if (bySpawnKey) return { id: bySpawnKey.id };
  // Legacy first-run Chief created before spawnKey was set.
  const byName = bots.find((bot) => bot.name === FIRST_BOT_NAME);
  return byName ? { id: byName.id } : undefined;
}

async function createOrReuseFirstBot(): Promise<{ id: string }> {
  const existing = await rpc.bots.list();
  const reuse = findFirstBot(existing);
  if (reuse) return reuse;
  try {
    const created = await rpc.bots.create({
      name: FIRST_BOT_NAME,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
      spawnKey: FIRST_BOT_SPAWN_KEY,
    });
    return { id: created.id };
  } catch (error) {
    // Another tab won the unique (spaceId, spawnKey) race; reuse that bot only.
    const afterConflict = await rpc.bots.list();
    const winner = afterConflict.find((bot) => bot.spawnKey === FIRST_BOT_SPAWN_KEY);
    if (winner) return { id: winner.id };
    throw error;
  }
}

async function withFirstBotLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return run();
  return locks.request(FIRST_BOT_LOCK, run);
}

async function ensureFirstBot(): Promise<{ id: string }> {
  if (firstBotEnsure) return firstBotEnsure;
  // Web Lock serializes cross-tab creates; module promise covers same-tab StrictMode.
  // spawnKey makes create idempotent when locks are unavailable.
  // Clear after settle so a later empty-space visit re-lists instead of reusing a deleted id.
  firstBotEnsure = withFirstBotLock(createOrReuseFirstBot).finally(() => {
    firstBotEnsure = null;
  });
  return firstBotEnsure;
}

export function OnboardingPage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [step, setStep] = useState<"loading" | "agent" | "integrations" | "bot">("loading");
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [integrationSetup, setIntegrationSetup] = useState<IntegrationSetupState | null>(null);
  const [integrationServers, setIntegrationServers] = useState<string[]>([]);
  const createStartedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([
      rpc.agent.status().catch(() => null),
      rpc.integrationSetup.get().catch(() => null),
    ])
      .then(([agent, integrations]) => {
        setAgentStatus(agent);
        setIntegrationSetup(integrations);
        setStep(
          agent && !agentReady(agent) ? "agent" : integrations?.needsSetup ? "integrations" : "bot",
        );
      })
      .catch(() => setStep("bot"));
  }, []);

  async function createFirstBot() {
    if (createStartedRef.current) return;
    createStartedRef.current = true;
    setError(null);
    try {
      const bot = await ensureFirstBot();
      for (const serverId of integrationServers) {
        await rpc.mcp.assignments.approve({ botId: bot.id, serverId });
      }
      // Onboarding continues conversationally in the thread: greeting first,
      // then the focus choice (immediate for the first bot).
      const started = await rpc.onboarding
        .start({ botId: bot.id })
        .then(() => true)
        .catch(() => false);
      if (started) {
        await rpc.onboarding.promptFocus({ botId: bot.id }).catch(() => undefined);
      }
      navigate(`/app/${bot.id}`);
    } catch (err) {
      createStartedRef.current = false;
      setError(err instanceof Error ? err.message : t`Could not create your bot`);
    }
  }

  useEffect(() => {
    if (step !== "bot") return;
    void createFirstBot();
  }, [step]);

  return (
    <div className="min-h-full bg-background px-6 py-12">
      <div className="mx-auto w-full max-w-[560px]">
        {step === "loading" ? (
          <p className="text-muted-foreground">
            <Trans>Loading…</Trans>
          </p>
        ) : null}
        {step === "agent" && agentStatus ? (
          <OnboardingAgentStep
            initialStatus={agentStatus}
            onContinue={() => setStep(integrationSetup?.needsSetup ? "integrations" : "bot")}
          />
        ) : null}
        {step === "integrations" ? (
          <IntegrationSetup
            serverSetup
            initialState={integrationSetup}
            onDone={() => setStep("bot")}
            onServerConnected={(id) =>
              setIntegrationServers((current) => [...new Set([...current, id])])
            }
          />
        ) : null}
        {step === "bot" ? (
          <div>
            {error ? (
              <div>
                <p className="text-sm text-destructive">{error}</p>
                <Button className="mt-4" onClick={() => void createFirstBot()}>
                  <Trans>Try again</Trans>
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground">
                <Trans>Opening chat…</Trans>
              </p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
