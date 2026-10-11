import { beforeEach, describe, expect, it } from "vitest";
import { GLYPHS } from "../components/FileIcons";
import { familyOf, getPref, setPref, splitName } from "./documents";

// V3. Each family draws its own shape; a tint of one glyph would not tell a PDF from a spreadsheet.
describe("a file's family", () => {
  it("reads Drive's own file_type, and the extension for a file Drive has not typed yet", () => {
    expect(familyOf("PDF", "report.pdf")).toBe("pdf");
    expect(familyOf("Document", "brief.docx")).toBe("doc");
    expect(familyOf("Text", "notes.txt")).toBe("doc");
    expect(familyOf("Spreadsheet", "costs.xlsx")).toBe("sheet");
    expect(familyOf("Presentation", "pitch.pptx")).toBe("slides");
    expect(familyOf("Image", "photo.png")).toBe("other");
    // an upload on its way has a name and no type yet
    expect(familyOf(null, "costs.csv")).toBe("sheet");
    expect(familyOf("Unknown", "pitch.key")).toBe("slides");
    // "key" is a whole filename here, not an extension
    expect(familyOf(null, "key")).toBe("other");
  });

  it("gives every family a shape of its own", () => {
    const shapes = Object.values(GLYPHS).map((paths) => paths.join("|"));
    expect(new Set(shapes).size).toBe(shapes.length);
  });
});

// V2. The name gives way in the middle so the extension survives, in both views.
describe("a filename that is too long for its column", () => {
  it("keeps the extension apart from the part that may be shortened", () => {
    expect(splitName("quarterly report.pdf")).toEqual([
      "quarterly report",
      ".pdf",
    ]);
    expect(splitName("archive.tar.gz")).toEqual(["archive.tar", ".gz"]);
    expect(splitName("README")).toEqual(["README", ""]);
    expect(splitName(".gitignore")).toEqual([".gitignore", ""]);
    expect(splitName("v1.2 final notes")).toEqual(["v1.2 final notes", ""]);
  });
});

// V2 and V10. Both choices live in this browser, and a browser that refuses storage keeps the default.
describe("a choice this browser remembers", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });
  });

  it("gives back what was written, and the default for anything else", () => {
    expect(getPref("documents-view", ["list", "tiles"], "list")).toBe("list");
    setPref("documents-view", "tiles");
    expect(getPref("documents-view", ["list", "tiles"], "list")).toBe("tiles");
    setPref("documents-density", "compact");
    expect(
      getPref("documents-density", ["comfortable", "compact"], "comfortable"),
    ).toBe("compact");
    // a value left by an older build, or by hand
    setPref("documents-view", "gallery");
    expect(getPref("documents-view", ["list", "tiles"], "list")).toBe("list");
  });

  it("keeps the default when the store cannot be read or written", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("The operation is insecure.");
      },
    });
    expect(() => setPref("documents-view", "tiles")).not.toThrow();
    expect(getPref("documents-view", ["list", "tiles"], "list")).toBe("list");
  });
});
