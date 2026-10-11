import { describe, expect, it } from "vitest";
import { ASSETS, DRIVE, FRAPPE_AI, KB_TOOL } from "./peers";

// These names belong to frappe_ai, Frappe Drive and the MCP server. Metis may not rename one on its
// own, so each is written here exactly as its owner spells it and nowhere else.
describe("the names the other projects own", () => {
  it("spells frappe_ai's doctypes, methods and chunk event", () => {
    expect(FRAPPE_AI.session).toBe("AI Chat Session");
    expect(FRAPPE_AI.message).toBe("AI Chat Message");
    expect(FRAPPE_AI.respond).toBe("frappe_ai.api.confirm.respond");
    expect(FRAPPE_AI.start).toBe("frappe_ai.api.chat.start_stream");
    expect(FRAPPE_AI.cancel).toBe("frappe_ai.api.chat.cancel_stream");
    expect(FRAPPE_AI.chunks("s1")).toBe("frappe_ai:chunk:s1");
  });

  it("spells Drive's methods and its own pages", () => {
    expect(DRIVE.upload).toBe("drive.api.files.upload_file");
    expect(DRIVE.content).toBe("drive.api.files.get_file_content");
    expect(DRIVE.rename).toBe("drive.api.files.rename");
    expect(DRIVE.createFolder).toBe("drive.api.files.create_folder");
    expect(DRIVE.move).toBe("drive.api.files.move");
    expect(DRIVE.trash).toBe("drive.api.files.remove_or_restore");
    expect(DRIVE.page("abc")).toBe("/drive/f/abc");
    expect(DRIVE.page("abc", true)).toBe("/drive/d/abc");
  });

  it("spells the MCP server's tool and the path Frappe serves this app from", () => {
    expect(KB_TOOL).toBe("search_knowledge_base");
    expect(ASSETS).toBe("/assets/rag/ask");
  });
});
