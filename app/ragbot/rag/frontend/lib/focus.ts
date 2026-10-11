import { useEffect, useRef, type RefObject } from "react";

// When the control holding the keyboard focus is replaced, nothing takes the focus back: it falls to
// <body> and the next Tab starts again from the top of the page. WCAG 2.2 failure F85, against 2.4.3
// Focus Order (A); and the ARIA Authoring Practices Guide's Dialog (Modal) pattern for the dialogs.

type Opener = { current: { focus: () => void } | null };

// Radix's modal <Dialog.Content> prevents the default restore and focuses its <Dialog.Trigger>
// instead (@radix-ui/react-dialog 1.1.23, dist/index.mjs:154-157); a dialog opened from a menu item
// renders none, so that ref is null and the restore is already prevented. Name the opener here.
export function handBack(event: Event, opener: Opener) {
  event.preventDefault();
  opener.current?.focus();
}

// Nobody holds the focus: a reader who has moved on somewhere else keeps where they are.
export const adrift = (active: unknown, body: unknown) =>
  active == null || active === body;

// The control that takes the place of one that has been removed — what F85 asks for: whatever now
// stands where it stood, or the last, when the one that went was last. `at` comes from an indexOf,
// so -1 is "it was not one of these at all", and then nothing here follows it.
export const successor = <T>(left: T[], at: number): T | null =>
  at < 0 ? null : (left[at] ?? left.at(-1) ?? null);

// Gives the focus to `to` when `on` changes — a ref, or a function when the target is only on screen
// after that render. It compares against the last value rather than counting renders, because
// StrictMode runs an effect twice on mount and does not reset the ref in between.
export function useHandover(
  on: unknown,
  to: RefObject<HTMLElement | null> | (() => HTMLElement | null),
) {
  const was = useRef(on);
  useEffect(() => {
    if (was.current === on) return;
    was.current = on;
    if (adrift(document.activeElement, document.body))
      (typeof to === "function" ? to() : to.current)?.focus();
  }, [on, to]);
}
