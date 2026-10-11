import { describe, expect, it } from "vitest";
import { applyChunk, newTurn, threadStatus, type Turn } from "./chat";

const running = (): Turn => ({
  ...newTurn("assistant", "", 0),
  steps: [{ name: "search_knowledge_base", args: {}, at: 0, done: false }],
});

describe("an answer the user stopped", () => {
  it("is not shown as a finished one", () => {
    const t = applyChunk(running(), { type: "stopped" }, 2_000);
    expect(t.status).toBe("stopped");
    expect(t.endedAt).toBe(2_000);
    expect(t.usage).toBeUndefined();
    expect(t.steps[0].done).toBe(true);
  });

  it("stays stopped when the relay's end arrives after it", () => {
    const stopped = applyChunk(running(), { type: "stopped" }, 2_000);
    const late = applyChunk(
      stopped,
      { type: "done", usage: { output_tokens: 12, output_seconds: 1 } },
      3_000,
    );
    expect(late).toEqual(stopped);
  });

  it("is reported to the thread as cancelled, and a failed one as an error", () => {
    expect(threadStatus("stopped")).toEqual({
      type: "incomplete",
      reason: "cancelled",
    });
    expect(threadStatus("error")).toEqual({
      type: "incomplete",
      reason: "error",
    });
    expect(threadStatus("done")).toEqual({ type: "complete", reason: "stop" });
    expect(threadStatus("running")).toEqual({ type: "running" });
  });
});
