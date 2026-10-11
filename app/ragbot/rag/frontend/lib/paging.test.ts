import { afterEach, describe, expect, it, vi } from "vitest";
import { list } from "./frappe";
import { history } from "./useChat";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

const row = (name: string) => ({
  name,
  role: "user",
  content: `message ${name}`,
  created_at: "2026-09-23 10:00:00",
});

// the query string of the first request the code under test made
const asked = (fetch: ReturnType<typeof vi.fn>) =>
  new URL(String(fetch.mock.calls[0][0]), "http://metis.test").searchParams;

afterEach(() => vi.unstubAllGlobals());

describe("what is past the page size is still reachable", () => {
  it("a chat reopens on its newest turns, in the order they were said", async () => {
    // the rows a newest-first query answers with
    const fetch = vi.fn(async () =>
      json({ data: [row("600"), row("599"), row("598")] }),
    );
    vi.stubGlobal("fetch", fetch);
    expect((await history("s1")).map((r) => r.name)).toEqual([
      "598",
      "599",
      "600",
    ]);
    const q = asked(fetch);
    expect(q.get("order_by")).toBe("created_at desc");
    expect(q.get("limit")).toBe("500");
    // tool rows the thread never shows must not spend the limit
    expect(JSON.parse(q.get("filters") ?? "[]")).toContainEqual([
      "role",
      "in",
      ["user", "assistant"],
    ]);
  });

  it("a list can be asked for the page after the rows already held", async () => {
    const fetch = vi.fn(async () => json({ data: [] }));
    vi.stubGlobal("fetch", fetch);
    await list("AI Chat Session", { fields: ["name"], limit: 100, start: 100 });
    expect(asked(fetch).get("limit_start")).toBe("100");
  });

  it("a list asked for no page starts at the first row", async () => {
    const fetch = vi.fn(async () => json({ data: [] }));
    vi.stubGlobal("fetch", fetch);
    await list("AI Chat Session", { fields: ["name"] });
    expect(asked(fetch).get("limit_start")).toBe("0");
  });
});
