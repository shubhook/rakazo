import { expect, test } from "@playwright/test";
import { captureScreenshot, signup } from "./helpers";

test("offers Sign in with ChatGPT when the browser shares the server's computer", async ({
  page,
}, testInfo) => {
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({ json: { passwordReset: false, resetUrl: null, chatgpt: "browser" } }),
  );
  await page.route("**/api/auth/chatgpt/start", (route) =>
    route.fulfill({ json: { flowId: "flow-1", url: "https://auth.openai.com/oauth/authorize" } }),
  );
  await page.route("**/api/auth/chatgpt/finish", (route) =>
    route.fulfill({ json: { status: "error", error: "Registration is closed" } }),
  );
  await page.route("https://auth.openai.com/**", (route) => route.fulfill({ body: "" }));

  await page.route("**/api/auth/get-session", (route) => route.fulfill({ json: null }));
  await page.goto("/sign-in");
  const button = page.getByRole("button", { name: "Sign in with ChatGPT" });
  await expect(button).toBeVisible();
  await captureScreenshot(page, testInfo, "sign-in-chatgpt");

  await button.click();
  await expect(page.getByRole("alert")).toHaveText("Registration is closed", { timeout: 10_000 });
  await expect(button).toBeEnabled();
});

test("hides Sign in with ChatGPT for a server on another computer", async ({ page }) => {
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({ json: { passwordReset: false, resetUrl: null, chatgpt: null } }),
  );
  await page.route("**/api/auth/get-session", (route) => route.fulfill({ json: null }));
  await page.goto("/sign-in");
  await expect(page.getByRole("button", { name: "Continue with email" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with ChatGPT" })).toHaveCount(0);
});

test("onboarding accepts ChatGPT in place of Claude Code", async ({ page }, testInfo) => {
  let chatgpt = false;
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({ json: { passwordReset: false, resetUrl: null, chatgpt: "browser" } }),
  );
  await page.route("**/rpc/agent/status", (route) =>
    route.fulfill({
      json: {
        json: {
          agent: "claude-code",
          chatgpt,
          installed: false,
          version: null,
          loggedIn: false,
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
  await page.route("**/api/auth/chatgpt/start", (route) =>
    route.fulfill({ json: { flowId: "flow-1", url: "https://auth.openai.com/oauth/authorize" } }),
  );
  await page.route("**/api/auth/chatgpt/finish", (route) => {
    chatgpt = true;
    return route.fulfill({ json: { status: "connected", created: false, plan: true } });
  });
  await page.route("https://auth.openai.com/**", (route) => route.fulfill({ body: "" }));

  const stamp = Date.now();
  await signup(page, `agent-chatgpt-${stamp}@rakazo.test`, "password12", `ChatGPT ${stamp}`);
  await expect(page.getByRole("heading", { name: "Connect your agent" })).toBeVisible({
    timeout: 20_000,
  });
  const continueButton = page.getByRole("button", { name: "Continue" });
  await expect(continueButton).toBeDisabled();
  await page.getByRole("button", { name: "Sign in with ChatGPT" }).click();
  await expect(page.getByText("Milo runs your bots on your ChatGPT plan.")).toBeVisible({
    timeout: 10_000,
  });
  await expect(continueButton).toBeEnabled();
  await captureScreenshot(page, testInfo, "onboarding-agent-chatgpt");
});
