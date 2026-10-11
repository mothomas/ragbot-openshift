// Ask one question the way Metis does (start_stream + the realtime channel) and print each chunk as
// a JSON line {t, type}, then a final {end, type, t}. Never prints the sid or answer text.
// env: WEB SITE AUSER APASS MESSAGE TIMEOUT_S
import { io } from "socket.io-client";

const WEB = process.env.WEB ?? "http://test.localhost:8081";
const SITE = process.env.SITE ?? "test.localhost";
const TIMEOUT = Number(process.env.TIMEOUT_S ?? 360) * 1000;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

const login = await fetch(`${WEB}/api/method/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ usr: process.env.AUSER, pwd: process.env.APASS }),
});
const sid = (login.headers.getSetCookie().find((c) => c.startsWith("sid=")) ?? "").split(";")[0].slice(4);
const cookie = `sid=${sid}`;
const html = await (await fetch(`${WEB}/ask`, { headers: { Cookie: cookie } })).text();
const csrf = (html.match(/"csrf_token":\s*"([^"]*)"/) ?? [])[1] ?? "";

const socket = io(`${WEB}/${SITE}`, { extraHeaders: { Cookie: cookie, Origin: WEB }, transports: ["websocket"] });
await new Promise((ok, fail) => { socket.once("connect", ok); socket.once("connect_error", fail); });
const session = crypto.randomUUID();
const t0 = Date.now();
let last = null;
const finish = (type) => { out({ end: true, type, t: Date.now() - t0, session, sid_len: sid.length, ...(process.env.EXPOSE_SID ? { sid } : {}) }); socket.close(); process.exit(0); };
// Metis ends the turn when its realtime connection drops (rag/frontend/lib/useChat.ts): a chunk published while
// the socket is down never arrives, so a browser never sees an end unless it makes one. Same rule here.
socket.on("disconnect", (reason) => {
  out({ t: Date.now() - t0, type: "disconnect", reason });
  finish("error");
});
socket.on(`frappe_ai:chunk:${session}`, (c) => {
  last = c.type;
  // the confirmation id is only what a click sends back; the grant it mints never reaches a browser
  out({ t: Date.now() - t0, type: c.type, ...(c.type === "error" ? { message: String(c.message ?? "").slice(0, 160) } : {}), ...(c.type === "tool_confirm" ? { id: c.id, name: c.name } : {}) });
  if (c.type === "done" || c.type === "error") finish(c.type);
});
const r = await fetch(`${WEB}/api/method/frappe_ai.api.chat.start_stream`, {
  method: "POST", headers: { "Content-Type": "application/json", "X-Frappe-CSRF-Token": csrf, Cookie: cookie, ...(process.env.REQUEST_ID ? { "X-Frappe-Request-Id": process.env.REQUEST_ID } : {}) },
  body: JSON.stringify({ message: process.env.MESSAGE ?? "What is the Kestrel allowance? Search the knowledge base.", session_id: session, page_context: {} }),
});
out({ t: Date.now() - t0, type: "start_stream", status: r.status });
// A refused start enqueues no relay, so no chunk can ever come. Both clients end the turn on it
// (rag/frontend/lib/useChat.ts send()'s catch, frappe_ai's useChat.ts _runTurn's); without this the
// probe waits out TIMEOUT_S and reports a hang where a browser shows the server's message.
if (!r.ok) finish("error");
setTimeout(() => finish(`timeout-after-${last ?? "nothing"}`), TIMEOUT);
