import { describe, expect, it } from "vitest";
import {
  applyChunk,
  fromHistory,
  newTurn,
  stepLabel,
  type Chunk,
  type Turn,
} from "./chat";

const run = (chunks: Chunk[]) =>
  chunks.reduce<Turn>(
    (t, c, i) => applyChunk(t, c, 1000 + i * 1000),
    newTurn("assistant", "", 0),
  );

describe("applyChunk", () => {
  it("merges streamed text into one part and records when the answer began", () => {
    const t = run([
      { type: "content", text: "The" },
      { type: "content", text: " cap" },
    ]);
    expect(t.parts).toEqual([{ kind: "text", text: "The cap" }]);
    expect(t.answerAt).toBe(1000);
  });
  it("finishes a step when the next event arrives", () => {
    const t = run([
      {
        type: "tool_call",
        name: "search_knowledge_base",
        arguments: { query: "meal cap" },
      },
      { type: "content", text: "45" },
    ]);
    expect(t.steps).toHaveLength(1);
    expect(t.steps[0].done).toBe(true);
  });
  it("keeps block order between text", () => {
    const t = run([
      { type: "content", text: "Here:" },
      { type: "content_block", block: { type: "kpi", metrics: [] } },
      { type: "content", text: "Done" },
    ]);
    expect(t.parts.map((p) => p.kind)).toEqual(["text", "block", "text"]);
  });
  it("adds each passage once", () => {
    const item = { file: "a", seq: 0, distance: 0.2, content: "x" };
    const t = run([
      { type: "sources", items: [item] },
      { type: "sources", items: [item] },
    ]);
    expect(t.sources).toEqual([item]);
  });
  it("marks done and error", () => {
    expect(run([{ type: "done" }]).status).toBe("done");
    expect(
      run([
        { type: "done", usage: { output_tokens: 368, output_seconds: 10.859 } },
      ]).usage,
    ).toEqual({ output_tokens: 368, output_seconds: 10.859 });
    const e = run([{ type: "error", message: "agent down" }]);
    expect([e.status, e.error]).toEqual(["error", "agent down"]);
  });
});

describe("stepLabel", () => {
  it("reads as plain words with the query", () => {
    const s = {
      name: "search_knowledge_base",
      args: { query: "meal cap" },
      at: 0,
      done: false,
    };
    expect(stepLabel(s)).toBe("Searching your documents for “meal cap”");
    expect(stepLabel({ ...s, done: true })).toBe(
      "Searched your documents for “meal cap”",
    );
    expect(stepLabel({ ...s, name: "list_documents", args: {} })).toBe(
      "Using list documents",
    );
  });
});

describe("fromHistory", () => {
  it("rebuilds turns with saved sources and blocks", () => {
    const turns = fromHistory(
      [
        {
          name: "1",
          role: "user",
          content: "cap?",
          created_at: "2026-09-18 10:00:00",
        },
        {
          name: "2",
          role: "assistant",
          content: "45 AUD.",
          created_at: "2026-09-18 10:00:30",
          tool_args_json: JSON.stringify([
            { name: "search_knowledge_base", args: { query: "cap" } },
          ]),
          tool_result_json: JSON.stringify({
            sources: [{ file: "a", seq: 0, distance: 0.1, content: "x" }],
            blocks: [],
            usage: { output_tokens: 368, output_seconds: 10.859 },
          }),
        },
      ],
      "UTC",
    );
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(turns[1].sources).toHaveLength(1);
    expect(turns[1].steps[0].done).toBe(true);
    expect(turns[1].status).toBe("done");
    expect(turns[1].usage).toEqual({
      output_tokens: 368,
      output_seconds: 10.859,
    });
    // a reopened answer's work region shows how long it took, not how old it is
    expect(turns[1].startedAt).toBe(Date.parse("2026-09-18T10:00:00Z"));
    expect(turns[1].endedAt).toBe(Date.parse("2026-09-18T10:00:30Z"));
  });
});
