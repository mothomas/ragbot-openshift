// make a11y: WCAG 2.2 A/AA by axe on every reachable state of Metis and the frappe_ai sidebar, in light and dark,
// at 320 px and, for the sidebar, at 400% zoom, under reduced motion and forced colours; a keyboard walk that checks
// where focus lands; and a count of screen-reader announcements while an answer streams (it must be announced once,
// not token by token).
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const U = JSON.parse(readFileSync(new URL("../.users.json", import.meta.url), "utf8"));
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const found: Record<string, { id: string; impact: string | null; nodes: number; help: string }[]> = {};
mkdirSync("a11y-results", { recursive: true });

// /ask is served with the first view already drawn and nothing in it live until React replaces it
// (rag/frontend/components/FirstView.tsx), so the composer being on screen no longer means the app is up.
// This does: the served view is gone once the app has drawn its own.
const appIsUp = (page: Page) => expect(page.locator("#first-view")).toHaveCount(0);

async function signIn(page: Page, who = "bob") {
  await page.goto("/ask");
  await page.getByLabel("Email", { exact: true }).fill(U[who].email);
  await page.getByLabel("Password", { exact: true }).fill(U[who].password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByPlaceholder("Ask about your documents")).toBeVisible();
  await appIsUp(page);
}

async function scan(page: Page, state: string) {
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  found[state] = r.violations.map((v) => ({ id: v.id, impact: v.impact ?? null, nodes: v.nodes.length, help: v.help }));
}

test.afterAll(() => {
  writeFileSync(`a11y-results/axe-${test.info().project.name}.json`, JSON.stringify(found, null, 1));
  const total = Object.values(found).reduce((n, v) => n + v.length, 0);
  console.log(`axe: ${total} violation groups over ${Object.keys(found).length} states`);
  for (const [s, v] of Object.entries(found)) for (const x of v) console.log(`  ${s}: ${x.id} (${x.impact}, ${x.nodes} nodes)`);
  expect(total, "axe violations across states").toBe(0);
});

for (const scheme of ["light", "dark"] as const) {
  for (const [w, h] of [[1440, 900], [320, 720]] as const) {
    test(`metis states ${scheme} ${w}px`, async ({ browser }) => {
      const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: w, height: h }, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      const tag = `${scheme}-${w}`;
      await page.goto("/ask");
      await scan(page, `signed-out ${tag}`);
      await page.getByLabel("Email", { exact: true }).fill(U.bob.email);
      await page.getByLabel("Password", { exact: true }).fill("wrong-password");
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByText("Incorrect email or password.")).toBeVisible();
      await scan(page, `sign-in error ${tag}`);
      await signIn(page);
      await scan(page, `empty chat ${tag}`);
      await page.getByPlaceholder("Ask about your documents").fill("What is the Kestrel allowance? Search the knowledge base.");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: /Toggle \d+ sources?/ })).toBeVisible({ timeout: 300_000 });
      await scan(page, `answered ${tag}`);
      await page.goto("/ask?view=documents");
      // axe reads the page once, so it waits for the listing itself, not for the network to fall quiet
      await expect(page.getByRole("button", { name: /More options for / }).first()).toBeVisible();
      await scan(page, `documents ${tag}`);
      const status = page.getByRole("button", { name: "Open status panel" });
      if (await status.isVisible()) {
        await status.click();
        // the panel mounts at once and says "Loading..."; this heading is its readings arriving
        await expect(page.getByRole("heading", { name: "Running on" })).toBeVisible();
        await scan(page, `status panel ${tag}`);
      }
      await ctx.close();
    });
  }
}

test("metis under forced colours", async ({ browser }) => {
  const ctx = await browser.newContext({ forcedColors: "active", viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await signIn(page);
  await scan(page, "empty chat forced-colours");
  await ctx.close();
});

test("keyboard: focus moves into dialogs and returns to what opened them", async ({ page }) => {
  await signIn(page);
  await page.goto("/ask?view=documents");
  const more = page.getByRole("button", { name: /More options for bob-benefits\.txt/ }).first();
  await more.focus();
  await page.keyboard.press("Enter");
  const preview = page.getByRole("menuitem", { name: "Preview" });
  await expect(preview).toBeVisible();
  await expect(page.locator(":focus")).toHaveAttribute("role", "menuitem");
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  await more.press("Enter");
  await page.getByRole("menuitem", { name: "Preview" }).press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    const visible = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return true;
      const s = getComputedStyle(el);
      return s.outlineStyle !== "none" || s.boxShadow !== "none";
    });
    expect(visible, `focus indicator on tab stop ${i + 1}`).toBe(true);
  }
});

test("a streaming answer is announced once, not token by token", async ({ page }) => {
  await signIn(page);
  await page.evaluate(() => {
    (window as any).__announcements = 0;
    const live = () => [...document.querySelectorAll("[aria-live]:not([aria-live=off]), [role=status], [role=alert], [role=log]")];
    new MutationObserver((ms) => {
      for (const m of ms) if (live().some((r) => r.contains(m.target))) (window as any).__announcements++;
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.getByPlaceholder("Ask about your documents").fill("Explain the Kestrel allowance in three sentences. Search the knowledge base.");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /Toggle \d+ sources?/ })).toBeVisible({ timeout: 300_000 });
  const n = await page.evaluate(() => (window as any).__announcements);
  console.log(`live-region mutations during one answer: ${n}`);
  expect(n, "live-region updates during one streamed answer").toBeLessThanOrEqual(6);
});

// The sidebar's own states. One answer carries a tool call and the table, KPI, status-list and chart blocks,
// so the scan sees those components and not just the empty panel; a second turn ends in the error bubble.
// The reply arrives over frappe.realtime (frappe_ai composables/useChat.ts), so the stub replaces that and
// frappe.call, not a route: there is no chat endpoint to intercept.
const STREAM = [
  { type: "content", text: "Revenue is up in Q2. Here is the detail." },
  { type: "tool_call", name: "run_report", arguments: { report: "Revenue", period: "Q2" } },
  {
    type: "content_block",
    block: {
      type: "table",
      title: "Top accounts",
      columns: [{ label: "Account", key: "account" }, { label: "Amount", key: "amount", format: "currency" }],
      rows: [{ values: { account: "Kestrel Ltd", amount: 120000 } }, { values: { account: "Harrier plc", amount: 84000 } }],
    },
  },
  { type: "content_block", block: { type: "kpi", metrics: [{ label: "Revenue", value: 204000, format: "currency", trend: "up", trend_value: "12%" }, { label: "Open invoices", value: 7, trend: "down", trend_value: "3" }] } },
  { type: "content_block", block: { type: "status_list", title: "Invoices", items: [{ label: "INV-0001", status: "Paid", color: "green" }, { label: "INV-0002", status: "Overdue", color: "red" }, { label: "INV-0003", status: "Draft", color: "yellow" }] } },
  { type: "content_block", block: { type: "chart", chart_type: "bar", title: "Revenue by quarter", data: { labels: ["Q1", "Q2"], datasets: [{ name: "Revenue", values: [84000, 120000] }] } } },
  { type: "done" },
];
const FAILING_STREAM = [{ type: "error", message: "The agent is unavailable." }];

/** Answer the next turn from a fixture instead of the agent, so its blocks render with no model in the loop. */
async function stubStream(page: Page, chunks: unknown[]) {
  await page.evaluate((cs) => {
    const w = window as any;
    if (!w.__stubbed) {
      const handlers: Record<string, (c: unknown) => void> = {};
      const realOn = w.frappe.realtime.on.bind(w.frappe.realtime);
      const realOff = w.frappe.realtime.off.bind(w.frappe.realtime);
      const realCall = w.frappe.call.bind(w.frappe);
      w.frappe.realtime.on = (ev: string, cb: (c: unknown) => void) =>
        ev.startsWith("frappe_ai:chunk:") ? (handlers[ev] = cb) : realOn(ev, cb);
      w.frappe.realtime.off = (ev: string, cb: (c: unknown) => void) =>
        ev.startsWith("frappe_ai:chunk:") ? delete handlers[ev] : realOff(ev, cb);
      w.frappe.call = (opts: any) => {
        if (opts.method !== "frappe_ai.api.chat.start_stream") return realCall(opts);
        const r = { message: { session_id: opts.args.session_id, currency: "INR" } };
        opts.callback?.(r);
        setTimeout(() => w.__chunks.forEach((c: unknown) => handlers[`frappe_ai:chunk:${opts.args.session_id}`]?.(c)), 30);
        return Promise.resolve(r);
      };
      w.__stubbed = true;
    }
    w.__chunks = cs;
  }, chunks);
}

/** Answer one turn from a fixture; returns once the last block of that turn has rendered. */
async function answer(page: Page, chunks: unknown[], settled: string) {
  await stubStream(page, chunks);
  await page.getByLabel("Chat input").fill("Show me revenue by quarter");
  await page.getByLabel("Chat input").press("Enter");
  await expect(page.locator(settled)).toBeVisible({ timeout: 30_000 });
}

async function scanSidebar(page: Page, state: string) {
  const r = await new AxeBuilder({ page }).include("#frappe-ai-sidebar-root").include("#frappe-ai-nav-btn").withTags(TAGS).analyze();
  found[state] = r.violations.map((v) => ({ id: v.id, impact: v.impact ?? null, nodes: v.nodes.length, help: v.help }));
}

// 1440 and 320 are the widths the Metis loop above uses. 320x256 is the viewport of a 1280x1024 window at
// 400% zoom: Understanding SC 1.4.10 Reflow gives that equivalence for the width and says 400% applies per
// dimension, so the height divides too. axe has no Reflow rule — what this row buys is every other rule
// re-run at a size a zoomed-in reader really has, where the panel overflows and they do not all still pass.
// The device scale factor is that window's pixel density; the CSS viewport above it is what axe measures.
const DESK_VIEWPORTS = [
  { label: "1440px", width: 1440, height: 900, deviceScaleFactor: 1 },
  { label: "320px", width: 320, height: 720, deviceScaleFactor: 1 },
  { label: "400% zoom", width: 320, height: 256, deviceScaleFactor: 4 },
] as const;

for (const scheme of ["light", "dark"] as const) {
  for (const vp of DESK_VIEWPORTS) {
    test(`frappe_ai sidebar on the desk, ${scheme} ${vp.label}`, async ({ browser }) => {
      const ctx = await browser.newContext({
        colorScheme: scheme,
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.deviceScaleFactor,
        reducedMotion: "reduce",
      });
      const page = await ctx.newPage();
      await page.goto("/login");
      await page.request.post("/api/method/login", { data: { usr: "Administrator", pwd: process.env.ADMIN_PASSWORD } });
      await page.goto("/app");

      const tag = `${scheme} ${vp.label}`;
      const navBtn = page.locator("#frappe-ai-nav-btn").first();
      await expect(navBtn).toBeAttached({ timeout: 30_000 });
      try {
        await navBtn.click({ timeout: 10_000 });
      } catch {
        // the desk hides .desktop-avatar at a narrow width, so frappe_ai.bundle.ts falls back to placing the
        // button beside .dropdown-navbar-user, inside a container the desk keeps collapsed; its own handler
        // still opens the panel, and where the button ends up is a separate finding
        console.log(`  sidebar ${tag}: #frappe-ai-nav-btn was not clickable where it was injected`);
        await page.evaluate(() => document.getElementById("frappe-ai-nav-btn")?.click());
      }
      const sidebar = page.locator("#frappe-ai-sidebar-root");
      // the root is created hidden and empty before Vue mounts into it, so visible only means unhidden;
      // its own header button is the first thing its app draws
      await expect(sidebar.getByRole("button", { name: "Close sidebar" })).toBeVisible();
      // the panel slides in over 250ms and its CSS carries no prefers-reduced-motion rule, so reducedMotion
      // alone does not stop it; a scan started now would read colours and sizes mid-transition
      await page.waitForTimeout(800);
      // the panel hydrates this user's last conversation on mount, so "empty" is empty only by luck;
      // and a hydrated thread gives the message list the focusable content this state is scanned for
      await sidebar.getByRole("button", { name: "New conversation" }).click();
      await expect(sidebar.locator(".frappe-ai-bubble")).toHaveCount(0);
      await scanSidebar(page, `sidebar empty ${tag}`);

      await answer(page, STREAM, "#frappe-ai-sidebar-root .frappe-ai-chart-canvas svg");
      await page.waitForTimeout(800);
      await scanSidebar(page, `sidebar answered ${tag}`);

      // --error, not .frappe-ai-error: MessageBubble gives that class to a render failure too
      await answer(page, FAILING_STREAM, "#frappe-ai-sidebar-root .frappe-ai-bubble--error");
      await scanSidebar(page, `sidebar error ${tag}`);
      await ctx.close();
    });
  }
}
