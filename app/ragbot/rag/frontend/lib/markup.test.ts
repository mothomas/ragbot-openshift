import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// This suite has no DOM (no jsdom, no @testing-library), so what a rendered assertion would check —
// that the drawer behaves like a dialog, that a name reaches the accessibility tree — is guaranteed
// by the markup, and read from the source here. The browser's own checks live in tests/system/e2e/.
const source = (file: string) =>
  readFileSync(new URL(`../components/${file}`, import.meta.url), "utf8");

describe("the phone sidebar drawer", () => {
  it("is a Radix modal dialog opened by a Dialog.Trigger", () => {
    expect(source("Sidebar.tsx")).toContain("<Dialog.Content");
    expect(source("App.tsx")).toContain("<Dialog.Trigger");
  });
});

describe("names the accessibility tree would otherwise miss", () => {
  it("starts the account button's name with the name the button shows", () => {
    expect(source("Sidebar.tsx")).toContain(
      "`${boot().full_name}, account and theme`",
    );
  });
  it("gives the chat's file chips a role that may be named", () => {
    expect(source("Chat.tsx")).toMatch(
      /role="group"[\s\S]{0,160}aria-label="Files in this chat"/,
    );
  });
  it("gives the answer and the question each a heading", () => {
    expect(source("Chat.tsx")).toContain(
      '<h2 className="sr-only">You said</h2>',
    );
    expect(source("Chat.tsx")).toMatch(/<h2 className="text-\[0\.9375rem\]/);
  });
  it("says what a passage's percentage measures, not only on hover", () => {
    expect(source("parts.tsx")).toContain(
      '<span className="sr-only">Relevance',
    );
  });
  it("says why an upload or an index failed, not only on hover", () => {
    expect(source("Documents.tsx")).toContain(
      '<span className="sr-only">. {u.error}</span>',
    );
    expect(source("Documents.tsx")).toContain(
      '<span className="sr-only">. {item.why}</span>',
    );
  });
});

describe("controls a keyboard has to be able to reach", () => {
  it("hides an older answer's actions with CSS, not by unmounting them", () => {
    // assistant-ui's autohide returns null unless message.isHovering, and only mouseenter sets that
    // (@assistant-ui/react 0.15.20, ActionBarRoot.tsx:97 and MessageRoot.tsx:30-37)
    expect(source("Chat.tsx")).not.toContain("autohide=");
    expect(source("Chat.tsx")).toContain("focus-within:opacity-100");
  });
});
