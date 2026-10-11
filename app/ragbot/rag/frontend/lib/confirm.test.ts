import { describe, expect, it, vi } from "vitest";
import {
  applyChunk,
  askLabel,
  fromHistory,
  newTurn,
  type Ask,
  type Chunk,
  type Turn,
} from "./chat";
import { respond } from "./useChat";

const post = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
// frappe_ai.api.confirm.respond is another repository's endpoint and is being written now: this
// stands in for it, so what this side sends is pinned without waiting for what answers it
vi.mock("./frappe", async (orig) => ({
  ...(await orig<typeof import("./frappe")>()),
  post,
}));

const ARGS = { doctype: "ToDo", values: { description: "zephyr" } };
const run = (chunks: Chunk[]) =>
  chunks.reduce<Turn>(
    (t, c, i) => applyChunk(t, c, 1000 + i * 1000),
    newTurn("assistant", "", 0),
  );
const ask: Ask = {
  id: "9f1c",
  name: "create_document",
  arguments: ARGS,
  state: "waiting",
};

describe("a write the agent paused", () => {
  it("becomes a card in the turn that asked, and ends that turn", () => {
    const t = run([
      {
        type: "tool_call",
        name: "search_knowledge_base",
        arguments: { query: "zephyr" },
      },
      { type: "content", text: "Create a new ToDo record." },
      {
        type: "tool_confirm",
        id: "9f1c",
        name: "create_document",
        arguments: ARGS,
      },
      { type: "done" },
    ]);
    expect(t.ask).toEqual(ask);
    expect(t.parts).toEqual([
      { kind: "text", text: "Create a new ToDo record." },
    ]);
    expect(t.steps.map((s) => s.done)).toEqual([true]);
    expect(t.status).toBe("done");
  });

  it("reads in Open WebUI's own words, before and after a Deny", () => {
    expect(askLabel(ask)).toBe("Allow create_document?");
    expect(askLabel({ ...ask, state: "denied" })).toBe(
      "Denied create_document",
    );
    // an expired card still asks; the server's line goes under it
    expect(askLabel({ ...ask, state: "expired" })).toBe(
      "Allow create_document?",
    );
  });

  it("is not restored by a reopened chat, so no answer cancels it", () => {
    const [turn] = fromHistory(
      [
        {
          name: "1",
          role: "assistant",
          content: "Create a new ToDo record.",
          created_at: "2026-09-23 10:00:00",
        },
      ],
      "UTC",
    );
    expect(turn.ask).toBeUndefined();
  });
});

describe("what Allow and Deny post", () => {
  it("is the id and the decision, and nothing the model could read back", async () => {
    post.mockClear();
    await respond("9f1c", "allow");
    expect(post).toHaveBeenLastCalledWith("frappe_ai.api.confirm.respond", {
      confirmation_id: "9f1c",
      decision: "allow",
    });
    await respond("9f1c", "deny");
    expect(post).toHaveBeenLastCalledWith("frappe_ai.api.confirm.respond", {
      confirmation_id: "9f1c",
      decision: "deny",
    });
    // the grant is minted in Frappe on the click: the browser never holds one to send
    expect(JSON.stringify(post.mock.calls)).not.toMatch(/token/i);
  });
});
