import type { Actor } from "@milo/contracts";
import type { PrismaClient } from "@milo/db";
import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

const actor = {
  spaceId: "workspace-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
} satisfies Actor;

const restricted = {
  mode: "restricted",
  allowedDomains: ["pypi.org", "*.githubusercontent.com"],
  allowedTcp: ["github.com:22"],
};

function setup(
  computer: Record<string, unknown> = {},
  options: { egress?: boolean; providerId?: string; saved?: number } = {},
) {
  const updateMany = vi.fn().mockResolvedValue({ count: options.saved ?? 1 });
  const prisma = {
    bot: {
      findFirst: vi.fn().mockResolvedValue({
        id: "bot-1",
        thread: { id: "thread-1" },
        computer: {
          id: "computer-1",
          userId: "user-1",
          kind: "docker",
          state: "stopped",
          egressMode: "open",
          egressAllowedDomains: [],
          egressAllowedTcp: [],
          ...computer,
        },
      }),
    },
    computer: { updateMany },
  } as unknown as PrismaClient;
  const sandbox = {
    describe: () => ({
      id: options.providerId ?? "docker",
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: { egress: options.egress ?? true },
    }),
  };
  const deps = {
    prisma,
    sandbox,
    env: { webOrigin: "http://127.0.0.1:5173", sandboxProvider: "docker" },
    dataDir: "/tmp/rakazo-router-test",
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  const call = async (procedure: string, json: Record<string, unknown>) => {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/computer/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botId: "bot-1", ...json } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return { status: response.status, body: await response.json() };
  };
  return { call, updateMany };
}

describe("computer egress RPCs", () => {
  it("defaults to open and reports provider support", async () => {
    const { call } = setup();
    await expect(call("egress", {})).resolves.toEqual({
      status: 200,
      body: {
        json: { policy: { mode: "open", allowedDomains: [], allowedTcp: [] }, supported: true },
      },
    });
  });

  it("saves a normalized policy on a stopped computer", async () => {
    const { call, updateMany } = setup();
    const result = await call("setEgress", {
      policy: {
        ...restricted,
        allowedDomains: [" PyPI.org", "pypi.org", "*.githubusercontent.com"],
      },
    });
    expect(result).toEqual({
      status: 200,
      body: { json: { policy: restricted, supported: true } },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "computer-1",
        state: { in: ["stopped", "suspended", "error"] },
        maintenanceId: null,
      },
      data: {
        egressMode: "restricted",
        egressAllowedDomains: ["pypi.org", "*.githubusercontent.com"],
        egressAllowedTcp: ["github.com:22"],
      },
    });
  });

  it("rejects invalid entries before touching the database", async () => {
    const { call, updateMany } = setup();
    const result = await call("setEgress", {
      policy: { mode: "restricted", allowedDomains: ["169.254.169.254"], allowedTcp: [] },
    });
    expect(result.status).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("refuses a restricted policy when the provider cannot enforce it", async () => {
    const { call, updateMany } = setup({ kind: "e2b" }, { egress: false, providerId: "e2b" });
    const result = await call("setEgress", { policy: restricted });
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toContain("cannot restrict network access");
    expect(updateMany).not.toHaveBeenCalled();
    await expect(call("egress", {})).resolves.toMatchObject({
      body: { json: { supported: false } },
    });
  });

  it("refuses a restricted policy on a host computer behind the Docker provider", async () => {
    const { call, updateMany } = setup({ kind: "desktop" });
    expect((await call("setEgress", { policy: restricted })).status).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("still allows switching an unsupported computer back to open", async () => {
    const { call, updateMany } = setup({ kind: "e2b" }, { egress: false, providerId: "e2b" });
    const result = await call("setEgress", {
      policy: { mode: "open", allowedDomains: [], allowedTcp: [] },
    });
    expect(result.status).toBe(200);
    expect(updateMany).toHaveBeenCalledOnce();
  });

  it("requires the computer to be stopped", async () => {
    const { call } = setup({ state: "running" }, { saved: 0 });
    const result = await call("setEgress", { policy: restricted });
    expect(result.status).toBe(409);
    expect(JSON.stringify(result.body)).toContain("Stop the computer");
  });

  it("is owner-only", async () => {
    const { call, updateMany } = setup({ userId: "someone-else" });
    expect((await call("egress", {})).status).toBe(403);
    expect((await call("setEgress", { policy: restricted })).status).toBe(403);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
