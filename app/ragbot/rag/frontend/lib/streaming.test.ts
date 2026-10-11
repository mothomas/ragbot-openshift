import { describe, expect, it } from "vitest";
import { applyChunk, newTurn, streaming, type Turn } from "./chat";

const asked = (): Turn[] => [
  { ...newTurn("user", "How much leave do I have?", 0), status: "done" },
  newTurn("assistant", "", 0),
];

describe("the hairline across the top of the conversation", () => {
  it("is there while the answer is arriving", () => {
    expect(streaming(asked())).toBe(true);
  });

  it("is gone the moment the answer settles, however it ended", () => {
    const [user, bot] = asked();
    for (const c of [
      { type: "done" } as const,
      { type: "stopped" } as const,
      { type: "error", message: "The answer was cut off." } as const,
    ])
      expect(streaming([user, applyChunk(bot, c, 1_000)])).toBe(false);
  });

  it("is not there on a chat nobody has asked anything yet", () => {
    expect(streaming([])).toBe(false);
  });

  it("follows the newest turn, not an older one left running", () => {
    const [user, bot] = asked();
    expect(streaming([bot, user])).toBe(false);
  });
});
