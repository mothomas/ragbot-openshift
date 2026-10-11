import { composeEventHandlers } from "radix-ui/internal";
import { describe, expect, it } from "vitest";
import { adrift, handBack, successor } from "./focus";

// The close sequence the installed Radix runs, driven by its own composeEventHandlers: react-dialog
// 1.1.23 dist/index.mjs:154-157 wraps what <Dialog.Content> is given, then prevents the default and
// focuses <Dialog.Trigger>; react-focus-scope 1.1.16 dist/index.mjs:96-101 restores only if nothing did.
function close(
  onCloseAutoFocus: ((e: Event) => void) | undefined,
  trigger: { focus: () => void } | null,
) {
  let landed = "<body>";
  const event = {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  composeEventHandlers(onCloseAutoFocus as (e: unknown) => void, (e) => {
    (e as Event).preventDefault();
    trigger?.focus();
  })(event);
  if (!event.defaultPrevented) landed = "the control that opened it";
  return landed;
}

describe("handBack", () => {
  it("shows why a dialog with no Trigger loses the focus to <body>", () => {
    expect(close(undefined, null)).toBe("<body>");
  });

  it("gives the focus to the opener the caller names", () => {
    let landed = "<body>";
    const opener = { current: { focus: () => (landed = "the ⋯ button") } };
    close((e) => handBack(e, opener), null);
    expect(landed).toBe("the ⋯ button");
  });
});

describe("successor", () => {
  // Move and Move to Trash: the dialog hands the focus back to the row's ⋯, then the reload takes
  // that row away with it. `left` is what the reload leaves, `at` where the row that went stood.
  const left = (rows: string[], gone: number) =>
    rows.filter((_, i) => i !== gone);

  it("is the row that took the removed one's place", () => {
    expect(successor(left(["a", "b", "c"], 1), 1)).toBe("c");
  });

  it("is the row before it, when the one that went was last", () => {
    expect(successor(left(["a", "b", "c"], 2), 2)).toBe("b");
  });

  it("is nothing when the row that went was the only one", () => {
    expect(successor(left(["a"], 0), 0)).toBe(null);
  });

  it("is nothing when what opened the dialog was no row of its own", () => {
    expect(successor(["a", "b", "c"], -1)).toBe(null);
  });
});

describe("adrift", () => {
  const body = { tag: "body" };
  it("is true once the control that had the focus is gone", () => {
    expect(adrift(body, body)).toBe(true);
    expect(adrift(null, body)).toBe(true);
  });
  it("is false while a reader holds the focus somewhere of their own", () => {
    expect(adrift({ tag: "button" }, body)).toBe(false);
  });
});
