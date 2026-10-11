import { describe, expect, it } from "vitest";
import { fromHistory, type Row } from "./chat";

// A reopened chat is rebuilt from rows the agent wrote. Two of those columns are JSON the browser
// did not write and must not trust, and one marker in `content` turns an answer into a failure.
// lib/chat.test.ts covers the happy path; these are the rows that are not it.
const row = (r: Partial<Row>): Row => ({
  name: "1",
  role: "assistant",
  content: "",
  created_at: "2026-09-18 20:30:40",
  ...r,
});

const turn = (r: Partial<Row>) => fromHistory([row(r)], "UTC")[0];

describe("fromHistory", () => {
  it("reads a saved failure back as a failed turn, without the marker", () => {
    const t = turn({ content: "[error] The answer was cut off." });
    expect(t.status).toBe("error");
    expect(t.error).toBe("The answer was cut off.");
    // the marker's text is the error, not the answer: showing both would say it twice
    expect(t.parts).toEqual([]);
  });

  it("keeps a message that only mentions an error as the answer it is", () => {
    const t = turn({ content: "The [error] tag marks a failed answer." });
    expect(t.status).toBe("done");
    expect(t.error).toBeUndefined();
    expect(t.parts).toEqual([
      { kind: "text", text: "The [error] tag marks a failed answer." },
    ]);
  });

  it("shows the answer when the saved JSON is malformed, rather than losing the turn", () => {
    const t = turn({
      content: "The cap is 45.",
      tool_args_json: '[{"name": "search_knowledge_ba',
      tool_result_json: "{sources: not json}",
    });
    expect(t.parts).toEqual([{ kind: "text", text: "The cap is 45." }]);
    expect(t.steps).toEqual([]);
    expect(t.sources).toEqual([]);
    expect(t.usage).toBeUndefined();
    expect(t.status).toBe("done");
  });

  it("treats a null JSON column as nothing saved", () => {
    // JSON.parse(null) answers null, not a failure, so the `s ?` guard is what keeps it out
    expect(
      turn({ content: "x", tool_args_json: null, tool_result_json: null }),
    ).toMatchObject({ steps: [], sources: [] });
  });

  it("gives a tool call with no arguments an empty argument list", () => {
    const t = turn({ content: "x", tool_args_json: '[{"name": "one"}]' });
    expect(t.steps).toEqual([
      {
        name: "one",
        args: {},
        at: new Date("2026-09-18T20:30:40Z").getTime(),
        done: true,
      },
    ]);
  });

  it("drops the rows a reader has no turn for", () => {
    const rows = [
      row({ name: "1", role: "user", content: "cap?" }),
      row({ name: "2", role: "tool" as Row["role"], content: "{}" }),
      row({ name: "3", role: "assistant", content: "45" }),
    ];
    expect(fromHistory(rows, "UTC").map((t) => t.id)).toEqual(["1", "3"]);
  });
});
