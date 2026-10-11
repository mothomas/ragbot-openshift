import { describe, expect, it } from "vitest";
import { snapshot } from "./activity";
import { announce, noteIndexing, spoken } from "./announce";

// spoken() is what useAnnouncement() hands the live region, through useSyncExternalStore. <App>
// empties and refills the region on every new value, so the same words twice must be a new value.
describe("announce", () => {
  it("is a new value even when the same words are said twice", () => {
    announce("Indexed a.pdf");
    const first = spoken();
    announce("Indexed a.pdf");
    expect(spoken().text).toBe(first.text);
    expect(spoken().id).toBe(first.id + 1);
  });
});

describe("noteIndexing", () => {
  it("says what happened to a file it watched, and nothing for one already done", () => {
    noteIndexing([
      { name: "x", title: "x.pdf", state: "ready" },
      { name: "y", title: "y.pdf", state: "indexing" },
    ]);
    const before = spoken();
    noteIndexing([{ name: "y", title: "y.pdf", state: "ready" }]);
    expect(spoken()).toEqual({ id: before.id + 1, text: "Indexed y.pdf" });
    noteIndexing([{ name: "y", title: "y.pdf", state: "ready" }]);
    expect(spoken().id).toBe(before.id + 1);
  });

  it("tells a file it cannot read from a run that did not finish", () => {
    noteIndexing([
      { name: "p", title: "photo.png", state: "indexing" },
      { name: "o", title: "outage.txt", state: "indexing" },
    ]);
    noteIndexing([{ name: "p", title: "photo.png", state: "failed" }]);
    expect(spoken().text).toBe("Can't read photo.png");
    noteIndexing([{ name: "o", title: "outage.txt", state: "error" }]);
    expect(spoken().text).toBe("Indexing failed for outage.txt");
  });

  it("still fills the Status panel's activity feed with the same line", () => {
    noteIndexing([{ name: "z", title: "z.pdf", state: "indexing" }]);
    noteIndexing([{ name: "z", title: "z.pdf", state: "ready" }]);
    expect(snapshot()[0]).toMatchObject({ kind: "doc", text: "Indexed z.pdf" });
  });
});
