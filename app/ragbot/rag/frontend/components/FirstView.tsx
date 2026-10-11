"use client";
import Chat from "./Chat";

// The frame the greeting sits in. <Workspace> draws it too, from these same two strings, because where the
// greeting lands depends on every box above it: a shorthand copy here would put it somewhere else.
export const SHELL = "flex h-dvh";
export const MAIN = "@container flex-1 min-w-0 flex flex-col";

/** The landing drawn into the page Frappe serves: the app's own <Chat> in the app's own frame, so there is
 * one landing rather than two that can drift. What only the browser knows — theme, sidebar width, whether this
 * URL is the landing — the page's own boot script settles before the first pixel (H03B). */
export default function FirstView() {
  return (
    // inert: nothing in here is wired up yet and the app replaces the view whole, so a word typed into this
    // composer would be thrown away with it
    <div id="first-view" inert className={SHELL}>
      {/* the sidebar's column, empty: its buttons do nothing until React is up, but its width is the
          greeting's left edge */}
      <div className="hidden md:block shrink-0 first-rail" />
      <main className={MAIN}>
        <div className="h-12" /> {/* the header's height */}
        <Chat sessionId="" model={null} modelTip="" suggestions={[]} />
      </main>
    </div>
  );
}
