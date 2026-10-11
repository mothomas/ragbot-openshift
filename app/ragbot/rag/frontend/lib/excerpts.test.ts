import { describe, expect, it } from "vitest";
import { savedRefs, withExcerpts, type Source, type Turn } from "./chat";

const turn = (id: string, sources: Source[]): Turn => ({
  id,
  role: "assistant",
  parts: [],
  steps: [],
  sources,
  status: "done",
  startedAt: 0,
});

const where = (file: string, seq: number): Source => ({
  file,
  seq,
  distance: null,
});

describe("a reopened chat reads its excerpts back", () => {
  it("asks once for each place a passage was read, and not for text it already has", () => {
    const turns = [
      turn("a", [where("f1", 0), where("f1", 1)]),
      turn("b", [where("f1", 0), { ...where("f2", 3), content: "kept" }]),
    ];
    expect(savedRefs(turns)).toEqual([
      { file: "f1", seq: 0 },
      { file: "f1", seq: 1 },
    ]);
  });

  it("fills in what came back and marks what did not as gone", () => {
    const turns = [turn("a", [where("f1", 0), where("f1", 1)])];
    const filled = withExcerpts(turns, [
      {
        file: "f1",
        seq: 0,
        distance: null,
        content: "The allowance is 600 AUD.",
      },
    ]);
    expect(filled[0].sources.map((s) => s.content)).toEqual([
      "The allowance is 600 AUD.",
      "",
    ]);
  });

  it("leaves a chat saved in the old shape exactly as it was", () => {
    const turns = [turn("a", [{ ...where("f1", 0), content: "saved copy" }])];
    expect(savedRefs(turns)).toEqual([]);
    expect(withExcerpts(turns, [])).toEqual(turns);
  });
});
