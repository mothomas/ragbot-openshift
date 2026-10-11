// make smoke: four journeys through Metis on the test site: sign in, ask, a cited answer, permission denied.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const U = JSON.parse(readFileSync(new URL("../.users.json", import.meta.url), "utf8"));
const ALICE_FILE = U.alice.file;

// /ask is served with the first view already drawn and nothing in it live until React replaces it
// (rag/frontend/components/FirstView.tsx), so the composer being on screen no longer means the app is up.
// This does: the served view is gone once the app has drawn its own.
const appIsUp = (page: Page) => expect(page.locator("#first-view")).toHaveCount(0);

async function signIn(page: Page, who: string) {
  await page.goto("/ask");
  await page.getByLabel("Email", { exact: true }).fill(U[who].email);
  await page.getByLabel("Password", { exact: true }).fill(U[who].password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByPlaceholder("Ask about your documents")).toBeVisible();
  await appIsUp(page);
}

test("sign in: a wrong password is refused, the right one opens the chat", async ({ page }) => {
  await page.goto("/ask");
  await expect(page.getByRole("heading", { name: "Sign in to Metis" })).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill(U.bob.email);
  await page.getByLabel("Password", { exact: true }).fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Incorrect email or password.")).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill(U.bob.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByPlaceholder("Ask about your documents")).toBeVisible();
  await appIsUp(page);
});

test("ask: a question gets a cited answer from the asker's own document", async ({ page }) => {
  await signIn(page, "bob");
  await page.getByPlaceholder("Ask about your documents").fill("What is the Kestrel allowance? Search the knowledge base.");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-role=assistant] .markdown-prose").filter({ hasText: /\S/ }).first()).toBeVisible({ timeout: 300_000 });
  const sources = page.getByRole("button", { name: /Toggle \d+ sources?/ });
  await expect(sources).toBeVisible({ timeout: 300_000 });
  await sources.click();
  await expect(page.getByText("bob-benefits.txt").first()).toBeVisible();
});

test("permission denied: a user cannot open another user's file by its address", async ({ page }) => {
  await signIn(page, "carol");
  const r = await page.request.get(`/ask/files/${ALICE_FILE}/alice-roadmap.txt`);
  // soft: the status and the body are two independent things to learn from one request
  expect.soft([403, 404], "the preview address is refused").toContain(r.status());
  expect.soft(await r.text(), "the refusal carries none of the file").not.toContain("Adelaide expansion");
});

test("permission denied: another user's document is never cited", async ({ page }) => {
  await signIn(page, "carol");
  await page.getByPlaceholder("Ask about your documents").fill("What is Project Zephyr? Search the knowledge base.");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden({ timeout: 300_000 });
  // soft: one answer, two independent leaks to look for; a run that finds both says more than one that stops
  await expect.soft(page.getByText("alice-roadmap.txt"), "the file is not named").toHaveCount(0);
  await expect
    .soft(page.locator("[data-role=assistant]").last(), "the file is not quoted")
    .not.toContainText("Adelaide expansion");
});
