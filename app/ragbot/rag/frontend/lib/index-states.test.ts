import { describe, expect, it } from "vitest";
import { snapshot } from "./activity";
import { noteIndexing } from "./announce";

// The four states rag.ingest.index_state answers with. "failed" is a format the indexer cannot read,
// "error" a run that did not finish, which another run may.
describe("Activity tells the two failures apart", () => {
  it("names the file it could not read, and the one whose indexing failed", () => {
    noteIndexing([
      { name: "a", title: "photo.png", state: "indexing" },
      { name: "b", title: "outage.txt", state: "indexing" },
    ]);
    noteIndexing([
      { name: "a", title: "photo.png", state: "failed" },
      { name: "b", title: "outage.txt", state: "error" },
    ]);
    expect(
      snapshot()
        .slice(0, 2)
        .map((e) => [e.kind, e.text]),
    ).toEqual([
      ["bad", "Indexing failed for outage.txt"],
      ["bad", "Can't read photo.png"],
    ]);
  });
});
