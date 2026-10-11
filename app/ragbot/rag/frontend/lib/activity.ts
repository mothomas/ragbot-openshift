import { useSyncExternalStore } from "react";

// What this tab saw happen since it loaded, newest first: the Status panel's Activity block
export type Kind = "ok" | "bad" | "move" | "doc";
type Event = { id: number; at: number; kind: Kind; text: string };

const MAX = 10;
let events: Event[] = [];
let next = 0;
const listeners = new Set<() => void>();

export function log(kind: Kind, text: string, at = Date.now()) {
  events = [{ id: ++next, at, kind, text }, ...events].slice(0, MAX);
  listeners.forEach((f) => f());
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => void listeners.delete(f);
};
export const snapshot = () => events;
export const useActivity = () =>
  useSyncExternalStore(subscribe, snapshot, snapshot);
