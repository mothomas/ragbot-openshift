import { useSyncExternalStore } from "react";
import { log } from "./activity";

// What the page shows only in passing, said once to a screen reader: a file finished indexing, an
// upload failed, a search found nothing. WCAG 2.2 4.1.3 Status Messages (AA), technique ARIA22.
// <App> mounts the one region; this is what it reads.

// the id makes the same words said twice a new value, which is what <App> empties the region on
let said = { id: 0, text: "" };
const listeners = new Set<() => void>();

export function announce(text: string) {
  said = { id: said.id + 1, text };
  listeners.forEach((f) => f());
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => void listeners.delete(f);
};
export const spoken = () => said;
export const useAnnouncement = () =>
  useSyncExternalStore(subscribe, spoken, spoken);

// A file seen indexing that now reads ready or failed finished while this page watched it. The text
// lives here rather than in the Status panel's activity module, which a site can switch off.
const indexing = new Set<string>();
export function noteIndexing(
  files: { name?: string; title: string; state?: string }[],
) {
  for (const f of files) {
    if (!f.name) continue;
    if (f.state === "indexing") indexing.add(f.name);
    else if (indexing.delete(f.name)) {
      const text =
        f.state === "ready"
          ? `Indexed ${f.title}`
          : f.state === "failed"
            ? `Can't read ${f.title}`
            : `Indexing failed for ${f.title}`;
      announce(text);
      log(f.state === "ready" ? "doc" : "bad", text);
    }
  }
}
