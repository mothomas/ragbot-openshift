import type { ThreadMessageLike } from "@assistant-ui/react";
import { fromServer } from "./format";
import { KB_TOOL } from "./peers";

export const QUIET_LIMIT_MS = 300_000; // the agent answers in under two minutes on CPU; this catches a lost stream

export type Block = { type: string; [k: string]: unknown };
// where a passage was read: the identity of a source, live or saved
const key = (s: { file: string; seq: number }) => `${s.file}:${s.seq}`;
// An answer saves where it read a passage, not the passage, so `content` is absent until it has been read
// back: "" is one this reader may no longer open, undefined one that has not been asked for yet.
// file_name and attachment come with a file attached in this chat, which is not in Drive
export type Source = {
  file: string;
  seq: number;
  distance: number | null;
  content?: string;
  file_name?: string;
  attachment?: boolean;
};
export type Step = {
  name: string;
  args: Record<string, unknown>;
  at: number;
  done: boolean;
};
// Ollama's own count of the tokens an answer wrote, and the seconds it spent writing them
export type Usage = { output_tokens: number; output_seconds: number };
// A write the agent paused for: the turn ended on it and the tool has not run. The browser holds the
// id and nothing else — the call itself is the record frappe_ai kept, and the grant never comes here.
export type Ask = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  state: "waiting" | "denied" | "expired";
  message?: string; // the server's own line when the pause was already over
};
export type Part =
  { kind: "text"; text: string } | { kind: "block"; block: Block };
export type Turn = {
  id: string;
  role: "user" | "assistant";
  parts: Part[];
  steps: Step[];
  sources: Source[];
  ask?: Ask;
  status: "running" | "done" | "stopped" | "error";
  error?: string;
  startedAt: number;
  answerAt?: number;
  endedAt?: number;
  usage?: Usage;
};
export type Chunk =
  | { type: "session"; id: string }
  | { type: "tool_call"; name: string; arguments: Record<string, unknown> }
  | {
      type: "tool_confirm";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | { type: "content"; text: string }
  | { type: "content_block"; block: Block }
  | { type: "sources"; items: Source[] }
  | { type: "done"; usage?: Usage }
  | { type: "stopped" }
  | { type: "error"; message: string };

export function newTurn(role: Turn["role"], text: string, now: number): Turn {
  return {
    id: crypto.randomUUID(),
    role,
    parts: text ? [{ kind: "text", text }] : [],
    steps: [],
    sources: [],
    status: role === "user" ? "done" : "running",
    startedAt: now,
  };
}

const settle = (steps: Step[]) =>
  steps.map((s) => (s.done ? s : { ...s, done: true }));

export function applyChunk(t: Turn, c: Chunk, now: number): Turn {
  switch (c.type) {
    case "tool_call":
      return {
        ...t,
        steps: [
          ...settle(t.steps),
          { name: c.name, args: c.arguments ?? {}, at: now, done: false },
        ],
      };
    case "tool_confirm":
      return {
        ...t,
        ask: {
          id: c.id,
          name: c.name,
          arguments: c.arguments ?? {},
          state: "waiting",
        },
        steps: settle(t.steps),
      };
    case "content": {
      const last = t.parts.at(-1);
      const parts: Part[] =
        last?.kind === "text"
          ? [
              ...t.parts.slice(0, -1),
              { kind: "text", text: last.text + c.text },
            ]
          : [...t.parts, { kind: "text", text: c.text }];
      return {
        ...t,
        parts,
        steps: settle(t.steps),
        answerAt: t.answerAt ?? now,
      };
    }
    case "content_block":
      return {
        ...t,
        parts: [...t.parts, { kind: "block", block: c.block }],
        steps: settle(t.steps),
        answerAt: t.answerAt ?? now,
      };
    case "sources": {
      const seen = new Set(t.sources.map(key));
      return {
        ...t,
        sources: [...t.sources, ...c.items.filter((s) => !seen.has(key(s)))],
      };
    }
    case "done":
      return t.status === "running"
        ? {
            ...t,
            status: "done",
            steps: settle(t.steps),
            endedAt: now,
            usage: c.usage,
          }
        : t;
    case "stopped":
      return t.status === "running"
        ? { ...t, status: "stopped", steps: settle(t.steps), endedAt: now }
        : t;
    case "error":
      return {
        ...t,
        status: "error",
        error: c.message,
        steps: settle(t.steps),
        endedAt: now,
      };
    default:
      return t;
  }
}

// An answer is arriving while its own turn is running: the same status the thread reads, so the hairline
// cannot fall out of step with the bubble
export const streaming = (turns: Turn[]) => turns.at(-1)?.status === "running";

// assistant-ui's own states: an answer the user stopped is incomplete and cancelled, a failed one incomplete
// and an error, and only an answer the agent finished is complete
export function threadStatus(
  status: Turn["status"],
): ThreadMessageLike["status"] {
  switch (status) {
    case "running":
      return { type: "running" };
    case "done":
      return { type: "complete", reason: "stop" };
    case "stopped":
      return { type: "incomplete", reason: "cancelled" };
    case "error":
      return { type: "incomplete", reason: "error" };
  }
}

const TOOLS: Record<string, [string, string]> = {
  [KB_TOOL]: ["Searching your documents", "Searched your documents"],
};

export function stepLabel(s: Step): string {
  const words = s.name.replaceAll("_", " ");
  const [running, done] = TOOLS[s.name] ?? [`Using ${words}`, `Used ${words}`];
  const verb = s.done ? done : running;
  return typeof s.args.query === "string"
    ? `${verb} for “${s.args.query}”`
    : verb;
}

// Open WebUI v0.11.3's own words for a tool waiting on its user (en-US locale, ToolCallDisplay.svelte)
export const askLabel = (a: Ask) =>
  a.state === "denied" ? `Denied ${a.name}` : `Allow ${a.name}?`;

export type Row = {
  name: string;
  role: string;
  content: string;
  created_at: string;
  tool_args_json?: string | null;
  tool_result_json?: string | null;
};

const parse = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

// The agent saves an answer only once it is written, so a chat whose history ends on a question is a chat
// whose answer is still coming. Every turn answers on the same channel, so without its own running turn the
// next question's turn takes those chunks.
export function resumed(turns: Turn[], now: number): Turn[] {
  const asked = turns.at(-1);
  return asked?.role === "user" && now - asked.startedAt < QUIET_LIMIT_MS
    ? [...turns, newTurn("assistant", "", asked.startedAt)]
    : turns;
}

// How long to wait for the next chunk: the window is silence, not the whole answer, which may legitimately
// stream for longer. A resumed answer has only what is left of the window since its question, because a
// chunk it missed while the chat was closed would otherwise buy it a whole one.
export function quietDelay(lastChunkAt: number, now: number): number {
  return lastChunkAt + QUIET_LIMIT_MS - now;
}

export function savedRefs(turns: Turn[]): { file: string; seq: number }[] {
  const refs = new Map<string, { file: string; seq: number }>();
  for (const t of turns)
    for (const s of t.sources)
      if (s.content === undefined)
        refs.set(key(s), { file: s.file, seq: s.seq });
  return [...refs.values()];
}

// Every source asked for gets an excerpt or "": a passage rag did not hand back is one this reader may no
// longer open, which is not the same as one nobody has asked about yet.
export function withExcerpts(turns: Turn[], found: Source[]): Turn[] {
  const text = new Map(found.map((p) => [key(p), p.content ?? ""]));
  return turns.map((t) => ({
    ...t,
    sources: t.sources.map((s) =>
      s.content === undefined ? { ...s, content: text.get(key(s)) ?? "" } : s,
    ),
  }));
}

export function fromHistory(rows: Row[], zone: string): Turn[] {
  let asked = 0;
  return rows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => {
      const at = fromServer(r.created_at, zone).getTime();
      const saved = parse<{
        sources?: Source[];
        blocks?: Block[];
        usage?: Usage;
      }>(r.tool_result_json, {});
      const calls = parse<{ name: string; args: Record<string, unknown> }[]>(
        r.tool_args_json,
        [],
      );
      const error = r.content.startsWith("[error] ")
        ? r.content.slice(8)
        : undefined;
      if (r.role === "user") asked = at;
      // the agent saves the question before it runs and the answer after, so the gap is how
      // long the answer took; without it a reopened chat would show the answer's age instead
      const timing =
        r.role === "assistant"
          ? { startedAt: asked || at, answerAt: at, endedAt: at }
          : { startedAt: at };
      return {
        id: r.name,
        role: r.role as Turn["role"],
        parts: [
          ...(error ? [] : [{ kind: "text", text: r.content } as Part]),
          ...(saved.blocks ?? []).map(
            (block) => ({ kind: "block", block }) as Part,
          ),
        ],
        steps: calls.map((c) => ({
          name: c.name,
          args: c.args ?? {},
          at,
          done: true,
        })),
        sources: saved.sources ?? [],
        usage: saved.usage,
        status: error ? "error" : "done",
        error,
        ...timing,
      };
    });
}
