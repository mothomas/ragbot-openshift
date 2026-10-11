import { describe, expect, it } from "vitest";
import { fileKind } from "./filetype";

describe("a source's colour follows the name the row already shows", () => {
  it("reads the extension, whatever its case", () => {
    expect(fileKind("Handbook.pdf")).toBe("pdf");
    expect(fileKind("Handbook.PDF")).toBe("pdf");
    expect(fileKind("Leave policy.docx")).toBe("doc");
    expect(fileKind("Payroll.xlsx")).toBe("sheet");
    expect(fileKind("Onboarding.pptx")).toBe("slides");
  });

  it("gives everything else the grey", () => {
    expect(fileKind("Document")).toBe("other");
    expect(fileKind("archive.zip")).toBe("other");
    expect(fileKind("notes.")).toBe("other");
    expect(fileKind("")).toBe("other");
  });

  it("reads the last extension of a name that has several", () => {
    expect(fileKind("2026.budget.final.xlsx")).toBe("sheet");
  });
});
