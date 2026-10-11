// make visual: Playwright's own screenshot baselines for Metis and the frappe_ai sidebar, so a
// layout or styling regression fails a check instead of reaching the owner's eye. Only states that
// do not change between runs are pinned; screenshot.css takes the readings that do out of the
// picture. Baselines are per platform, so they are generated in the image CI uses, never here:
//   make test-stack test-site test-seed && make visual-baseline     (once, and review the pngs)
//   make visual                                                     (every run after that)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const U = JSON.parse(readFileSync(new URL("../.users.json", import.meta.url), "utf8"));
const STYLE = { stylePath: fileURLToPath(new URL("screenshot.css", import.meta.url)) };
const SIZES = [
  { tag: "desktop", width: 1440, height: 900 },
  { tag: "phone", width: 390, height: 844 },
] as const;

// /ask is served with the first view already drawn and nothing in it live until React replaces it
// (rag/frontend/components/FirstView.tsx), so the composer being on screen no longer means the app
// is up. This does: the served view is gone once the app has drawn its own.
const appIsUp = (page: Page) => expect(page.locator("#first-view")).toHaveCount(0);

for (const scheme of ["light", "dark"] as const) {
  for (const { tag, ...viewport } of SIZES) {
    const name = `${scheme}-${tag}`;

    test(`sign in ${name}`, async ({ browser }) => {
      const ctx = await browser.newContext({ colorScheme: scheme, viewport });
      const page = await ctx.newPage();
      await page.goto("/ask");
      await expect(page.getByRole("heading", { name: "Sign in to Metis" })).toBeVisible();
      await expect(page).toHaveScreenshot(`sign-in-${name}.png`);
      await ctx.close();
    });

    test(`empty chat ${name}`, async ({ browser }) => {
      const ctx = await browser.newContext({ colorScheme: scheme, viewport });
      const page = await ctx.newPage();
      await page.goto("/ask");
      await page.getByLabel("Email", { exact: true }).fill(U.bob.email);
      await page.getByLabel("Password", { exact: true }).fill(U.bob.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByPlaceholder("Ask about your documents")).toBeVisible();
      await appIsUp(page);
      // the suggestions are built from the documents call, so the view is not settled without them
      await expect(page.getByText("Suggested")).toBeVisible();
      // and the status chip is not in the page at all until its first poll answers; screenshot.css
      // holds its reading still, but only once there is a chip to hold
      await expect(page.locator("main > header .tabular-nums")).toBeAttached();
      await expect(page).toHaveScreenshot(`empty-chat-${name}.png`, STYLE);
      await ctx.close();
    });
  }
}

test("the frappe_ai sidebar on the desk", async ({ page }) => {
  await page.goto("/login");
  await page.request.post("/api/method/login", {
    data: { usr: "Administrator", pwd: process.env.ADMIN_PASSWORD },
  });
  await page.goto("/app");
  await page.locator("#frappe-ai-nav-btn").first().click();
  const sidebar = page.locator("#frappe-ai-sidebar-root");
  await expect(sidebar.getByRole("button", { name: "Close sidebar" })).toBeVisible();
  await expect(sidebar).toHaveScreenshot("frappe-ai-sidebar.png", STYLE);
});
