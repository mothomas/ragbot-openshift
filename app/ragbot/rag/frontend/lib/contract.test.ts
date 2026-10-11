import { describe, expect, it } from "vitest";
import type { Source } from "./chat";

// The two row shapes rag.search.search answers with: DRIVE_ROW and ATTACHED_ROW in
// rag/rag/tests/test_contract.py, and the passage in frappe-mcp-server's
// TestKnowledgeBaseReturnsItsPassagesAsStructuredContent. A rename has to visit all three.
const driveRow: Source = {
  file: "f1",
  seq: 3,
  content: "Mileage is reimbursed at 88 cents per kilometre.",
  distance: 0.14,
};
const attachedRow: Source = {
  ...driveRow,
  file_name: "contract-note.txt",
  attachment: true,
};

describe("the rows rag.search.search returns", () => {
  it("are what Source declares them to be, field for field", () => {
    expect(Object.keys(driveRow).sort()).toEqual([
      "content",
      "distance",
      "file",
      "seq",
    ]);
    expect(Object.keys(attachedRow).sort()).toEqual([
      "attachment",
      "content",
      "distance",
      "file",
      "file_name",
      "seq",
    ]);
  });
});
