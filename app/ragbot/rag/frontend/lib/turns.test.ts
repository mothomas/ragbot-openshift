import { describe, expect, it } from "vitest";
import {
  fromHistory,
  QUIET_LIMIT_MS,
  quietDelay,
  resumed,
  type Row,
} from "./chat";

const asked = (at: string): Row => ({
  name: "1",
  role: "user",
  content: "What is the meal cap?",
  created_at: at,
});
const answered = (at: string): Row => ({
  name: "2",
  role: "assistant",
  content: "45 AUD.",
  created_at: at,
});
const at = (ms: number) =>
  new Date(ms).toISOString().slice(0, 19).replace("T", " ");

describe("a chat opened while its answer is still coming", () => {
  const now = Date.parse("2026-09-23T10:00:00Z");

  it("keeps the unanswered question's own turn running, timed from when it was asked", () => {
    const history = fromHistory([asked(at(now - 20_000))], "UTC");
    const shown = resumed(history, now);
    expect(shown).toHaveLength(2);
    expect(shown[1].role).toBe("assistant");
    expect(shown[1].status).toBe("running");
    expect(shown[1].startedAt).toBe(now - 20_000);
  });

  it("leaves an answered chat alone", () => {
    const history = fromHistory(
      [asked(at(now - 20_000)), answered(at(now - 10_000))],
      "UTC",
    );
    expect(resumed(history, now)).toEqual(history);
  });

  it("leaves a question whose stream is long gone alone", () => {
    const history = fromHistory(
      [asked(at(now - QUIET_LIMIT_MS - 1_000))],
      "UTC",
    );
    expect(resumed(history, now)).toEqual(history);
  });
});

describe("how long an answer may be quiet", () => {
  const now = Date.parse("2026-09-23T10:00:00Z");

  it("gives an answer that is still streaming the whole window from its last chunk", () => {
    expect(quietDelay(now, now)).toBe(QUIET_LIMIT_MS);
    // a chunk arriving a minute before the window would have run out buys the whole window again
    expect(quietDelay(now, now + QUIET_LIMIT_MS - 60_000)).toBe(60_000);
  });

  it("gives a resumed answer only what is left of the window since its question", () => {
    expect(quietDelay(now - QUIET_LIMIT_MS + 30_000, now)).toBe(30_000);
  });
});
