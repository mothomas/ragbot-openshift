import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { poller } from "./poll";

// The browser's side of a poll, stubbed: a tab that can be hidden, and the event that wakes it.
// The listener store keys on the handler too, so a removal that hands back a different function
// leaves the old one in place, exactly as a browser would.
const listeners: [string, () => void][] = [];
const fire = (name: string) =>
  listeners.filter(([k]) => k === name).forEach(([, f]) => f());
const show = (shown: boolean) => {
  (document as { hidden: boolean }).hidden = !shown;
};

beforeEach(() => {
  vi.useFakeTimers();
  listeners.length = 0;
  vi.stubGlobal("document", { hidden: false });
  vi.stubGlobal("addEventListener", (k: string, f: () => void) =>
    listeners.push([k, f]),
  );
  vi.stubGlobal("removeEventListener", (k: string, f: () => void) => {
    const i = listeners.findIndex(([a, b]) => a === k && b === f);
    if (i >= 0) listeners.splice(i, 1);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// a request that takes `ms` and records how many were ever in flight together
function slow(ms: number) {
  const state = { calls: 0, inFlight: 0, peak: 0 };
  const tick = async () => {
    state.calls += 1;
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    await new Promise((r) => setTimeout(r, ms));
    state.inFlight -= 1;
  };
  return { state, tick };
}

describe("poller", () => {
  it("never has two requests in flight, however slow the server is", async () => {
    const { state, tick } = slow(4_000);
    const stop = poller(tick, 1_000);
    await vi.advanceTimersByTimeAsync(20_000);
    stop();
    expect(state.peak).toBe(1);
    // four calls in twenty seconds: each waits for the last to come back, then waits the interval
    expect(state.calls).toBe(4);
  });

  it("asks for nothing while the tab is hidden", async () => {
    const { state, tick } = slow(10);
    show(false);
    const stop = poller(tick, 1_000);
    await vi.advanceTimersByTimeAsync(20_000);
    stop();
    expect(state.calls).toBe(0);
  });

  it("polls at once when the tab comes back, and keeps going", async () => {
    const { state, tick } = slow(10);
    show(false);
    const stop = poller(tick, 1_000);
    await vi.advanceTimersByTimeAsync(20_000);
    show(true);
    fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(0);
    expect(state.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.calls).toBeGreaterThan(1);
    stop();
  });

  it("with `now`, the first call goes out at mount and still holds the next back", async () => {
    const { state, tick } = slow(4_000);
    const stop = poller(tick, 1_000, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.calls).toBe(1);
    // the mount call is the one in flight, so the 1 s tick must not start a second
    await vi.advanceTimersByTimeAsync(1_500);
    expect(state.peak).toBe(1);
    expect(state.calls).toBe(1);
    stop();
  });

  it("with `now`, a tab mounted in the background still asks for nothing", async () => {
    const { state, tick } = slow(10);
    show(false);
    const stop = poller(tick, 1_000, true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.calls).toBe(0);
    show(true);
    fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(0);
    stop();
    expect(state.calls).toBe(1);
  });

  it("a tab hidden and shown again mid-request does not start a second", async () => {
    const { state, tick } = slow(4_000);
    const stop = poller(tick, 1_000, true);
    await vi.advanceTimersByTimeAsync(100); // the mount call is in flight
    show(false);
    fire("visibilitychange");
    show(true);
    fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(0);
    stop();
    expect(state.peak).toBe(1);
    expect(state.calls).toBe(1);
  });

  it("a wake part-way through the interval leaves one chain, not two", async () => {
    const { state, tick } = slow(10);
    const stop = poller(tick, 1_000);
    await vi.advanceTimersByTimeAsync(500); // half-way to the first tick
    fire("visibilitychange"); // polls now, and the tick it was waiting for must go with it
    await vi.advanceTimersByTimeAsync(10_000);
    stop();
    // one chain at 1 s for ten seconds, plus the wake's own call
    expect(state.calls).toBeLessThanOrEqual(11);
  });

  it("keeps polling after a request fails", async () => {
    let calls = 0;
    const stop = poller(() => {
      calls += 1;
      return Promise.reject(new Error("offline")).catch(() => {});
    }, 1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    stop();
    expect(calls).toBe(5);
  });

  it("stopped part-way through a request, it never polls again", async () => {
    const { state, tick } = slow(4_000);
    const stop = poller(tick, 1_000, true);
    await vi.advanceTimersByTimeAsync(1_000); // the mount call is still in flight
    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.calls).toBe(1);
  });

  it("stopped, it lets go of the tab it was listening to", async () => {
    const { state, tick } = slow(10);
    const stop = poller(tick, 1_000);
    stop();
    expect(listeners).toHaveLength(0);
    fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.calls).toBe(0);
  });
});
