import { expect, test } from "@playwright/test";
import { captureScreenshot, signup } from "./helpers";

test("onboarding skips agent setup when Claude Code is ready", async ({ page }, testInfo) => {
  await page.route("**/rpc/agent/status", (route) =>
    route.fulfill({
      json: {
        json: {
          agent: "claude-code",
          chatgpt: false,
          installed: true,
          version: "2.1.0",
          loggedIn: true,
          platform: "linux",
        },
      },
    }),
  );

  await page.route("**/rpc/integrationSetup/get", (route) =>
    route.fulfill({
      json: {
        json: {
          canConfigure: false,
          needsSetup: false,
          webUrl: "https://example.test/integrations/setup",
          providers: [],
        },
      },
    }),
  );

  const createRequest = page.waitForRequest("**/rpc/bots/create");
  const stamp = Date.now();
  await signup(
    page,
    `agent-auto-skip-${stamp}@rakazo.test`,
    "password12",
    `Agent auto skip ${stamp}`,
  );

  await expect(page.getByRole("heading", { name: "Connect your agent" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Server integrations" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Create your first bot" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Skip for now" })).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Description" })).toHaveCount(0);
  for (const name of ["Composio", "Pipedream", "Executor"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeHidden();
  }

  expect((await createRequest).postDataJSON()).toMatchObject({
    json: {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      spawnKey: "onboarding:first",
    },
  });
  await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible({
    timeout: 20_000,
  });
  await captureScreenshot(page, testInfo, "onboarding-auto-skip");
});
