import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding } from "./helpers";

test("a desktop on a local server asks only for a name and signs itself back in", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  // Stands in for the desktop main process: the account survives reloads like its file does.
  await page.addInitScript((seed) => {
    const key = "e2e:desktop-local-account";
    Object.defineProperty(window, "rakazoDesktop", {
      value: {
        platform: "darwin",
        window: {
          close: async () => {},
          minimize: async () => {},
          toggleMaximize: async () => {},
          state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
        },
        oauth: { onCallback: () => () => {} },
        update: {
          state: async () => ({
            phase: "unsupported",
            currentVersion: "0.1.6",
            availableVersion: null,
            percent: null,
            message: null,
            checkedAt: null,
          }),
        },
        localAccount: {
          read: async () => {
            const saved = localStorage.getItem(key);
            return { account: saved ? JSON.parse(saved) : null };
          },
          ensure: async () => {
            const saved = localStorage.getItem(key);
            if (saved) return JSON.parse(saved);
            const account = {
              email: `local-${seed}@desktop.rakazo.invalid`,
              password: `local-password-${seed}`,
            };
            localStorage.setItem(key, JSON.stringify(account));
            return account;
          },
        },
      },
    });
  }, stamp);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "What should we call you?" })).toBeVisible();
  await expect(page.getByPlaceholder("Your email address")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "01-desktop-local-name");
  await page.getByRole("textbox", { name: "Name" }).fill("Local Tester");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await completeOnboarding(page, testInfo);

  // An expired session signs back in with the held account, with no screen in between.
  await page.context().clearCookies();
  await page.goto("/app");
  await page.waitForURL(/\/app/, { timeout: 20_000 });
  await expect(page.getByText("Chief").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "What should we call you?" })).toHaveCount(0);

  await page.context().clearCookies();
  await page.goto("/sign-in?with=email");
  await expect(page.getByRole("heading", { name: "Sign in to Milo" })).toBeVisible();
});
