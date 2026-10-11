"use client";
import { useEffect } from "react";

/** Call `tick` every `ms`, one at a time, never while the tab is hidden, at once when it comes back. */
export function poller(
  tick: () => Promise<unknown>,
  ms: number,
  now = false,
): () => void {
  let next: ReturnType<typeof setTimeout> | undefined;
  let live = true;
  let running = false;
  const run = async () => {
    clearTimeout(next); // whoever wakes it takes the pending tick with them
    // a hung agent holds each request for seconds, and stacked polls would fill Frappe's 8 threads
    if (running || document.hidden) return;
    running = true;
    try {
      await tick();
    } finally {
      running = false;
      // a hidden tab arms nothing: visibilitychange starts it again
      if (live && !document.hidden) next = setTimeout(run, ms);
    }
  };
  const wake = () => void run();
  // the first call goes through run() like every other, or a slow one would not hold the next back
  if (now) wake();
  else next = setTimeout(run, ms);
  addEventListener("visibilitychange", wake);
  return () => {
    live = false;
    clearTimeout(next);
    removeEventListener("visibilitychange", wake);
  };
}

/** poller() as an effect. `tick` settles its own failures; a rejection here is loud, not swallowed. */
export function usePoll(
  tick: () => Promise<unknown>,
  ms: number,
  { on = true, now = false }: { on?: boolean; now?: boolean } = {},
): void {
  useEffect(
    () => (on ? poller(tick, ms, now) : undefined),
    [tick, ms, on, now],
  );
}
