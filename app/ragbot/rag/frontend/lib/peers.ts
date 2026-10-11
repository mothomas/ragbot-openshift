// The names the other projects own: frappe_ai's doctypes, whitelisted methods and realtime event,
// Drive's whitelisted methods and its own pages, the MCP server's knowledge-base tool, and the path
// Frappe serves this app's files from. Each is spelled the way its owner spells it, and only here.

export const FRAPPE_AI = {
  session: "AI Chat Session",
  message: "AI Chat Message",
  respond: "frappe_ai.api.confirm.respond",
  start: "frappe_ai.api.chat.start_stream",
  cancel: "frappe_ai.api.chat.cancel_stream",
  chunks: (session: string) => `frappe_ai:chunk:${session}`,
};

export const DRIVE = {
  upload: "drive.api.files.upload_file",
  content: "drive.api.files.get_file_content",
  rename: "drive.api.files.rename",
  createFolder: "drive.api.files.create_folder",
  move: "drive.api.files.move",
  trash: "drive.api.files.remove_or_restore",
  page: (name: string, folder = false) =>
    `/drive/${folder ? "d" : "f"}/${name}`,
};

export const KB_TOOL = "search_knowledge_base";

export const ASSETS = "/assets/rag/ask";
