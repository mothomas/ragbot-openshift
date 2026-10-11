// make firstpaint: what /ask has to download before it can draw anything. Metis is a static export that renders
// in the browser, so every script the served HTML names must arrive and run before the first pixel. Three things
// have to hold. The HTML names the chunk that holds Metis's own code: with next/dynamic ssr:false that chunk was
// left out of it, so the browser learned of it only after running everything the HTML did name, a round trip
// later. None of the scripts it names carries code that only a later view uses. And the HTML draws the first
// view itself, greeting and all, because downloading less could not reach the 2.5 s budget on its own.
import { expect, test, type APIRequestContext } from "@playwright/test";

// a string that only Metis's own code has, on the first view a reader gets
const FIRST_VIEW = "Ask about your documents";
const LATER_VIEWS = {
  "a markdown parser (the text of an answer)": "micromark",
  "a realtime client (an answer arriving)": "engine.io",
  "a chart library (a chart in an answer)": "recharts",
};

// the scripts the page tells the browser to run, by file name, with their bodies; noModule ones are for
// browsers that cannot run the modern build and are never fetched beside it
async function named(request: APIRequestContext): Promise<Record<string, string>> {
  const html = await (await request.get("/ask")).text();
  const src = [...html.matchAll(/<script\b[^>]*>/g)]
    .map(([tag]) => tag)
    .filter((tag) => !/noModule/i.test(tag))
    .flatMap((tag) => [...tag.matchAll(/src="([^"]+\.js)"/g)].map(([, url]) => url));
  const paths = [...new Set(src)];
  expect(paths, "the /ask HTML names no script at all").not.toHaveLength(0);
  const bodies = await Promise.all(paths.map(async (p) => (await request.get(p)).text()));
  return Object.fromEntries(paths.map((p, i) => [p.split("/").pop() as string, bodies[i]]));
}

test("the page names the script that draws it", async ({ request }) => {
  const scripts = await named(request);
  const holds = Object.keys(scripts).filter((n) => scripts[n].includes(FIRST_VIEW));
  expect(
    holds,
    `no script the /ask HTML names contains ${JSON.stringify(FIRST_VIEW)}: the browser must run every script it ` +
      `does name before it can even ask for the code that draws the page. Scripts named: ${Object.keys(scripts).join(", ")}`,
  ).not.toHaveLength(0);
});

// The greeting is the largest element on the first view, and waiting for React to draw it cost about 800 ms
// that deferring could not win back, so the page Frappe serves draws it itself. It carries the composer under
// it too: that is what puts the greeting where the app is about to redraw it.
test("the page draws the first view itself", async ({ request }) => {
  const html = await (await request.get("/ask")).text();
  // React writes a comment between the greeting's two text runs; what is left outside every script is the page
  const markup = html.replace(/<script\b[\s\S]*?<\/script>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const headings = [...markup.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map(([, t]) => t.trim());
  expect(
    headings.filter((t) => /^Hello, \S/.test(t)),
    "the served /ask HTML draws no greeting of its own, so the largest element on the first view waits for " +
      `every script to arrive and run. Headings in it: ${JSON.stringify(headings)}`,
  ).not.toHaveLength(0);
  expect(
    markup,
    "the served /ask HTML draws the greeting without the composer under it, so the app will redraw the " +
      "greeting somewhere other than where the reader first saw it",
  ).toContain(FIRST_VIEW);
  expect(
    /<div id="first-view"[^>]*\binert\b/.test(markup),
    "the first view the page draws is not inert: nothing in it is wired up until the app replaces it, so a " +
      "reader who types into that composer would lose what they typed",
  ).toBe(true);
});

test("the page names no script the first view has no use for", async ({ request }) => {
  const scripts = await named(request);
  for (const [what, marker] of Object.entries(LATER_VIEWS)) {
    const carrying = Object.keys(scripts).filter((n) => scripts[n].includes(marker));
    expect(carrying, `${what} is in ${carrying.join(", ")}, which the first view downloads before it can paint`).toHaveLength(0);
  }
});
