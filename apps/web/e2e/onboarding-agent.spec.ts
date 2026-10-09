import { expect, test } from "@playwright/test";
import { captureScreenshot, signup } from "./helpers";

test("onboarding waits for Claude Code before opening Chief", async ({ page }, testInfo) => {
  let installed = false;
  await page.route("**/rpc/agent/status", (route) =>
    route.fulfill({
      json: {
        json: {
          agent: "claude-code",
          installed,
          version: installed ? "2.1.0" : null,
          loggedIn: installed,
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

  const stamp = Date.now();
  await signup(page, `agent-setup-${stamp}@rakazo.test`, "password12", `Agent setup ${stamp}`);

  await expect(page.getByRole("heading", { name: "Connect your agent" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("Not installed")).toBeVisible();
  const continueButton = page.getByRole("button", { name: "Continue" });
  await expect(continueButton).toBeDisabled();
  await captureScreenshot(page, testInfo, "onboarding-agent-not-installed");

  await page.getByRole("button", { name: "Install" }).click();
  await expect(page.getByText("curl -fsSL https://claude.ai/install.sh | bash")).toBeVisible();
  await captureScreenshot(page, testInfo, "onboarding-agent-install-command");

  installed = true;
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Install" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "onboarding-agent-ready");

  await continueButton.click();
  await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible({
    timeout: 20_000,
  });
});
