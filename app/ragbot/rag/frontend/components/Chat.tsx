"use client";
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  BoltIcon,
  CheckIcon,
  ClipboardIcon,
  DocumentTextIcon,
  InformationCircleIcon,
  PlusIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { ArrowUpIcon, StopIcon } from "@heroicons/react/24/solid";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { announce, noteIndexing } from "@/lib/announce";
import {
  askLabel,
  streaming,
  threadStatus,
  type Source,
  type Turn,
  type Usage,
} from "@/lib/chat";
import { useHandover } from "@/lib/focus";
import { attach, firstName, get, post } from "@/lib/frappe";
import { bytes } from "@/lib/format";
import { KB_TOOL } from "@/lib/peers";
import { usePoll } from "@/lib/poll";
import { useChat } from "@/lib/useChat";
import { AppMark } from "./Mark";
import {
  AskActions,
  AskPart,
  BlockPart,
  ErrorPart,
  MarkdownText,
  NoSourcesPart,
  SourcesPart,
  TIP,
  TIP_ABOVE,
  WorkPart,
} from "./parts";

function toThread(t: Turn): ThreadMessageLike {
  const data = (name: string, d: object) => ({
    type: "data" as const,
    name,
    data: d,
  });
  const content =
    t.role === "user"
      ? t.parts.map((p) => ({
          type: "text" as const,
          text: p.kind === "text" ? p.text : "",
        }))
      : [
          data("work", {
            steps: t.steps,
            status: t.status,
            startedAt: t.startedAt,
            answerAt: t.answerAt,
            endedAt: t.endedAt,
          }),
          ...t.parts.map((p) =>
            p.kind === "text"
              ? { type: "text" as const, text: p.text }
              : data("block", p.block),
          ),
          ...(t.ask ? [data("ask", t.ask)] : []),
          ...(t.status === "done" &&
          !t.sources.length &&
          t.steps.some((s) => s.name === KB_TOOL)
            ? [data("no_sources", {})]
            : []),
          ...(t.error ? [data("error", { message: t.error })] : []),
        ];
  return {
    id: t.id,
    role: t.role,
    content,
    createdAt: new Date(t.startedAt),
    metadata: {
      custom: { sources: t.sources, ...(t.usage ? { usage: t.usage } : {}) },
    },
    // assistant-ui accepts a status on assistant messages only, and throws on a user message's
    ...(t.role === "assistant" ? { status: threadStatus(t.status) } : {}),
  };
}

const parts = {
  Text: ({ text }: { text: string }) => <MarkdownText text={text} />,
  data: {
    by_name: {
      work: ({ data }: { data: never }) => <WorkPart data={data} />,
      ask: ({ data }: { data: never }) => <AskPart data={data} />,
      error: ({ data }: { data: never }) => <ErrorPart data={data} />,
      block: ({ data }: { data: never }) => <BlockPart data={data} />,
      no_sources: () => <NoSourcesPart />,
    },
  },
};

function UserMessage() {
  return (
    <MessagePrimitive.Root
      data-role="user"
      className="w-full max-w-[58rem] mx-auto px-3.5 mb-3 flex justify-end"
    >
      <div className="rounded-3xl max-w-[90%] px-4 py-1.5 bg-gray-50 dark:bg-gray-850">
        <h2 className="sr-only">You said</h2>
        <MessagePrimitive.Parts components={{ Text: parts.Text }} />
      </div>
    </MessagePrimitive.Root>
  );
}

// Open WebUI's ⓘ under an answer: how fast the model wrote it, from the model's own timing
function Speed() {
  const usage = useAuiState(
    (s) => s.message.metadata.custom?.usage as Usage | undefined,
  );
  const id = useId();
  if (!usage) return null;
  return (
    <span className="relative group/tip">
      <button
        type="button"
        aria-label="Output speed"
        aria-describedby={id}
        className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 hover:text-black dark:hover:text-white"
      >
        <InformationCircleIcon className="size-4" strokeWidth={2.3} />
      </button>
      <span role="tooltip" id={id} className={`${TIP} left-0`}>
        {(usage.output_tokens / usage.output_seconds).toFixed(1)} tokens/s
        <br />
        {usage.output_tokens} tokens in {usage.output_seconds.toFixed(1)} s
      </span>
    </span>
  );
}

// Icon lines blur off whole device pixels, and the Sources pill's text width leaves these buttons off them.
// The offset is taken inside the scrolling thread, so scrolling keeps it.
function useSnap<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const thread = el?.closest(".overflow-y-auto");
    if (!el || !thread) return;
    const snap = () => {
      el.style.translate = "";
      const k = devicePixelRatio;
      const off = (v: number) => (Math.round(v * k) - v * k) / k;
      const r = el.getBoundingClientRect();
      el.style.translate = `${off(r.left)}px ${off(r.top - thread.getBoundingClientRect().top + thread.scrollTop)}px`;
    };
    snap();
    const watch = new ResizeObserver(snap);
    watch.observe(thread);
    if (thread.firstElementChild) watch.observe(thread.firstElementChild);
    return () => watch.disconnect();
  }, []);
  return ref;
}

// one row under an answer: the Sources pill, then the buttons, which older answers show on hover
function Footer() {
  const snap = useSnap<HTMLSpanElement>();
  // the check mark is the only sign the copy worked, and it is a CSS-only data attribute
  const copied = useAuiState((s) => s.message.isCopied);
  useEffect(() => {
    if (copied) announce("Copied");
  }, [copied]);
  const sources = useAuiState(
    (s) => s.message.metadata.custom?.sources as Source[] | undefined,
  );
  const last = useAuiState((s) => s.message.isLast);
  const actions = (
    <span ref={snap} className="flex">
      {/* not autohide: it unmounts the bar unless the mouse is over the message, so a keyboard
          could never reach these buttons. Hidden here the way the rest of the app hides a hover
          control, which keeps them in the tab order and shows them the moment one takes focus. */}
      <ActionBarPrimitive.Root
        hideWhenRunning
        className={`flex gap-0.5 text-gray-600 dark:text-gray-400 ${last ? "" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}`}
      >
        <Speed />
        <ActionBarPrimitive.Copy
          aria-label="Copy"
          className="group/copy p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 disabled:hidden"
        >
          <ClipboardIcon
            className="size-4 group-data-[copied]/copy:hidden"
            strokeWidth={2.3}
          />
          <CheckIcon
            className="size-4 hidden group-data-[copied]/copy:block"
            strokeWidth={2.3}
          />
        </ActionBarPrimitive.Copy>
      </ActionBarPrimitive.Root>
    </span>
  );
  return sources?.length ? (
    <SourcesPart data={{ items: sources }}>{actions}</SourcesPart>
  ) : (
    <div className="mt-1">{actions}</div>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root
      data-role="assistant"
      className="group w-full max-w-[58rem] mx-auto px-3.5 mb-3 flex gap-2"
    >
      <AppMark className="hidden @lg:block size-6 shrink-0" />
      <div className="min-w-0 flex-1 pl-1">
        <h2 className="text-[0.9375rem] leading-6 font-bold text-black dark:text-white mb-1">
          Metis
        </h2>
        <MessagePrimitive.Parts components={parts as never} />
        <Footer />
      </div>
    </MessagePrimitive.Root>
  );
}

// Lucide "brain" 1.47.0, ISC; at 14px a 1.75 stroke keeps its lines 1px, like Open WebUI's small icons
function BrainIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 18V5 M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4 M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5 M17.997 5.125a4 4 0 0 1 2.526 5.77 M18 18a4 4 0 0 0 2-7.464 M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517 M6 18a4 4 0 0 1-2-7.464 M6.003 5.125a4 4 0 0 0-2.526 5.77" />
    </svg>
  );
}

// What the indexer reads: PDF and text. Anything else would only come back "Can't read this file".
const ACCEPT = ".pdf,.txt,.md,.markdown,.csv,.html,.htm,application/pdf,text/*";
const readable = (f: File) =>
  f.type === "application/pdf" ||
  f.type.startsWith("text/") ||
  /\.(pdf|txt|md|markdown|csv|html?)$/i.test(f.name);

type ChatFile = {
  key: string;
  name?: string;
  file_name: string;
  file_size: number;
  state: "uploading" | "indexing" | "ready" | "failed" | "error";
  why?: string;
};
const stuck = (s: ChatFile["state"]) => s === "failed" || s === "error";

// Files attached to one chat, searched only in it. Polls while any is still being indexed.
function useChatFiles(session: string) {
  const [files, setFiles] = useState<ChatFile[]>([]);
  const [failed, setFailed] = useState(false);
  const removed = useRef(new Set<string>()); // chips removed while uploading: their file is detached once it exists
  const refresh = useCallback(
    () =>
      // the first view Frappe serves draws a chat nobody has opened yet, so there is nothing to ask about
      !session
        ? Promise.resolve()
        : get<Omit<ChatFile, "key">[]>("rag.chat.attachments", { session })
            .then((server) => {
              setFailed(false);
              noteIndexing(server.map((f) => ({ ...f, title: f.file_name })));
              // a new upload stays until the server lists it: a poll that started before it committed does not know it yet
              const listed = new Set(server.map((f) => f.name));
              setFiles((local) => [
                ...server.map((f) => ({ ...f, key: f.name! })),
                ...local.filter(
                  (f) =>
                    f.state === "uploading" ||
                    (!f.name && stuck(f.state)) ||
                    (f.name && f.state === "indexing" && !listed.has(f.name)),
                ),
              ]);
            })
            // the chips are as old as the last poll that arrived; a silent one leaves them wrong
            .catch(() => setFailed(true)),
    [session],
  );
  useEffect(() => void refresh(), [refresh]);
  const indexing = files.some((f) => f.state === "indexing");
  usePoll(refresh, 1_000, { on: indexing });
  const add = (list: Iterable<File>) => {
    for (const file of list) {
      const key = crypto.randomUUID();
      if (!readable(file)) {
        setFiles((fs) => [
          ...fs,
          {
            key,
            file_name: file.name,
            file_size: file.size,
            state: "failed",
            why: "Only PDF and text files",
          },
        ]);
        continue;
      }
      setFiles((fs) => [
        ...fs,
        { key, file_name: file.name, file_size: file.size, state: "uploading" },
      ]);
      attach(session, file)
        .then(({ name }) => {
          if (removed.current.delete(key))
            return void post("rag.chat.detach", { file: name }).catch(refresh);
          noteIndexing([{ name, title: file.name, state: "indexing" }]);
          setFiles((fs) =>
            fs.map((f) =>
              f.key === key ? { ...f, key: name, name, state: "indexing" } : f,
            ),
          );
        })
        .catch((e: Error) =>
          setFiles((fs) =>
            fs.map((f) =>
              f.key === key ? { ...f, state: "error", why: e.message } : f,
            ),
          ),
        );
    }
  };
  const remove = (f: ChatFile) => {
    setFiles((fs) => fs.filter((x) => x.key !== f.key));
    if (f.state === "uploading") removed.current.add(f.key);
    if (f.name) post("rag.chat.detach", { file: f.name }).catch(refresh);
  };
  return {
    files,
    failed,
    add,
    remove,
    busy: files.some((f) => f.state === "uploading" || f.state === "indexing"),
  };
}
type Files = ReturnType<typeof useChatFiles>;

const STATE = {
  uploading: "Uploading…",
  indexing: "Indexing…",
  ready: "",
  failed: "Can't read this file",
  error: "Indexing failed",
};

// Open WebUI's file chip: an icon tile, the name, and its type and size or what is happening
function FileChip({ f, onRemove }: { f: ChatFile; onRemove: () => void }) {
  const kind = f.file_name.split(".").pop()?.toUpperCase() ?? "File";
  const note = stuck(f.state)
    ? (f.why ?? STATE[f.state])
    : STATE[f.state] || `${kind} · ${bytes(f.file_size)}`;
  return (
    <div className="group relative flex items-center gap-2 rounded-2xl p-1.5 pr-3 bg-white dark:bg-gray-850 border border-gray-100 dark:border-gray-800 max-w-64">
      <span className="grid place-items-center size-10 shrink-0 rounded-xl bg-black/5 dark:bg-white/10 text-gray-600 dark:text-gray-300">
        {f.state === "uploading" || f.state === "indexing" ? (
          <span
            className="size-4 rounded-full border-2 border-current border-t-transparent animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <DocumentTextIcon className="size-5" aria-hidden="true" />
        )}
      </span>
      <span className="min-w-0">
        <span
          className="block text-sm text-gray-900 dark:text-gray-100 truncate"
          title={f.file_name}
        >
          {f.file_name}
        </span>
        <span
          className={`block text-xs ${stuck(f.state) ? "text-red-600 dark:text-red-400" : "text-gray-600 dark:text-gray-400"}`}
        >
          {note}
        </span>
      </span>
      <button
        type="button"
        aria-label={`Remove ${f.file_name}`}
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 grid place-items-center size-5 rounded-full bg-white dark:bg-gray-850 border border-gray-100 dark:border-gray-800 text-gray-600 dark:text-gray-300 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <XMarkIcon className="size-3" strokeWidth={2.5} />
      </button>
    </div>
  );
}

// Open WebUI's composer: the input on top, then a row with the model's name left and send right
function Composer({
  running,
  model,
  tip,
  files,
  input,
}: {
  running: boolean;
  model: string | null;
  tip: string;
  files: Files;
  input: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const picker = useRef<HTMLInputElement>(null);
  return (
    <ComposerPrimitive.Root className="w-full max-w-[58rem] mx-auto px-2 pb-4">
      <div className="w-full shadow-lg rounded-3xl border border-gray-100/30 dark:border-gray-850/30 bg-white/5 dark:bg-gray-500/5 backdrop-blur-sm px-0.5">
        {files.failed && (
          <p
            role="alert"
            className="px-3 pt-2.5 text-sm text-red-600 dark:text-red-400"
          >
            Connection failed
          </p>
        )}
        {files.files.length > 0 && (
          <div
            role="group"
            className="flex flex-wrap gap-2 px-2.5 pt-2.5"
            aria-label="Files in this chat"
          >
            {files.files.map((f) => (
              <FileChip key={f.key} f={f} onRemove={() => files.remove(f)} />
            ))}
          </div>
        )}
        <ComposerPrimitive.Input
          ref={input}
          submitOnEnter={!files.busy}
          // 22.5px of text and 12px of padding, which the library rounds to 35: min-h says it to a browser
          // that has no library yet, so the served composer is the height this one grows from
          rows={1}
          placeholder="Ask about your documents"
          className="block w-full resize-none bg-transparent outline-hidden text-[0.9375rem] px-3 pt-2.5 pb-0.5 min-h-[35px] max-h-96 placeholder:text-gray-600 dark:placeholder:text-gray-400"
        />
        <div className="flex items-center gap-1 mt-0.5 mb-2 ml-1 mr-1.5">
          <input
            ref={picker}
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              files.add(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <button
            type="button"
            aria-label="Attach files to this chat"
            title="Attach PDF or text files"
            onClick={() => picker.current?.click()}
            className="grid place-items-center size-8 rounded-full text-gray-600 dark:text-gray-300 hover:bg-black/5 dark:hover:bg-white/5"
          >
            <PlusIcon className="size-5" />
          </button>
          {model && (
            // like the round trip's chip: the tooltip is for the eye, the same words are read out
            <span className="relative group/tip min-w-0">
              <span className="block max-w-[10rem] sm:max-w-[13rem] truncate pl-1 pr-1.5 py-1 text-[0.8125rem] text-gray-600 dark:text-gray-300">
                {/* the icon's middle sits half a cap height above the baseline: centred on the letters in any font */}
                <BrainIcon className="inline size-3.5 mr-1.5 align-[calc(0.5cap-0.4375rem)]" />
                {model}
                {tip && <span className="sr-only">, {tip}</span>}
              </span>
              {tip && (
                <span aria-hidden="true" className={`${TIP_ABOVE} left-0`}>
                  {tip}
                </span>
              )}
            </span>
          )}
          {running ? (
            <ComposerPrimitive.Cancel
              aria-label="Stop"
              className="ml-auto rounded-full p-[0.3125rem] bg-black text-white dark:bg-white dark:text-black"
            >
              <StopIcon className="size-5" />
            </ComposerPrimitive.Cancel>
          ) : (
            <ComposerPrimitive.Send
              aria-label={files.busy ? "Send after the files are read" : "Send"}
              disabled={files.busy}
              className="ml-auto rounded-full p-[0.3125rem] bg-black text-white hover:bg-gray-900 dark:bg-white dark:text-black disabled:bg-gray-200 dark:disabled:bg-gray-700"
            >
              <ArrowUpIcon className="size-5" />
            </ComposerPrimitive.Send>
          )}
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}

type Suggestion = { title: string; hint: string; prompt: string };

type ChatProps = {
  sessionId: string;
  model: string | null; // the agent's model, named in the composer like Open WebUI
  modelTip: string; // where it runs and its context window, on the name's hover
  suggestions: Suggestion[];
  initial?: string; // a question to send as soon as the chat opens ("Ask about this")
  onStarted?: () => void; // the first question went out, so the chat now has an id worth a URL
  onDone?: () => void; // an answer finished, so the sidebar can show a newly created session
};

export default function Chat({
  sessionId,
  model,
  modelTip,
  suggestions,
  initial,
  onStarted,
  onDone,
}: ChatProps) {
  const { turns, running, send, cancel, allow, deny } = useChat(sessionId);
  const files = useChatFiles(sessionId);
  const [dragging, setDragging] = useState(false);
  // the first question unmounts the landing composer and Send swaps for Stop; the input that replaces
  // the one the reader was in takes the focus. assistant-ui's own autoFocus would do it, but it also
  // focuses on mount (ComposerInput.js:130), showing a caret at load, which the owner has not asked for.
  const input = useRef<HTMLTextAreaElement>(null);
  useHandover(running, input);
  const ask = (text: string) => {
    onStarted?.();
    return send(text);
  };
  const runtime = useExternalStoreRuntime<Turn>({
    messages: turns,
    isRunning: running,
    convertMessage: toThread,
    onNew: async (m) =>
      ask(m.content.map((p) => (p.type === "text" ? p.text : "")).join("")),
    onCancel: cancel,
  });
  const last = turns.at(-1);
  useEffect(() => {
    if (initial) ask(initial);
    // once per chat: the key on <Chat> remounts it for another question
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (last?.role === "assistant" && last.status !== "running") onDone?.();
  }, [last?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  // a card that arrives after the answer is read out too, or a screen reader is left on "Answer ready"
  const pending = turns.find((t) => t.ask?.state === "waiting")?.ask;
  const status = pending
    ? askLabel(pending)
    : last?.status === "running"
      ? last.steps.length
        ? "Searching your documents"
        : "Thinking"
      : last?.status === "done"
        ? "Answer ready"
        : "";
  useEffect(() => {
    if (status) announce(status);
  }, [status]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- a drop target for a pointer drag: no role describes one, and the attach button is the keyboard way to the same thing */}
      <div
        className="relative flex-1 min-h-0 flex flex-col"
        onDragEnter={(e) =>
          e.dataTransfer.types.includes("Files") && setDragging(true)
        }
      >
        {/* An answer is on its way. It does not move: an opacity pulse would dip the hairline to
            2.21:1, under 1.4.11's 3:1, so there is nothing for prefers-reduced-motion to turn off. */}
        {streaming(turns) && (
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-0 h-0.5 bg-state-working"
          />
        )}
        {/* Open WebUI's drop overlay: it covers the chat, so leaving it is leaving the drop area */}
        {dragging && (
          // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- the same drop target, while the drag is over it
          <div
            className="absolute inset-0 z-40 grid place-items-center backdrop-blur-sm bg-gray-100/50 dark:bg-gray-900/80"
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              files.add(Array.from(e.dataTransfer.files));
            }}
          >
            <div className="text-center pointer-events-none">
              <p className="text-lg text-gray-900 dark:text-gray-100">
                Add files
              </p>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                PDF and text files, searched only in this chat
              </p>
            </div>
          </div>
        )}
        {turns.length === 0 ? (
          // Open WebUI's landing: a 58rem column, the composer held to 48rem, suggestions to 42rem
          <div className="@container flex-1 flex flex-col justify-center pb-24">
            <div className="w-full max-w-[58rem] mx-auto px-1 @2xl:px-20">
              <h1 className="text-3xl text-gray-800 dark:text-gray-100 text-center mb-6">
                Hello, {firstName()}
              </h1>
              <div className="w-full @md:max-w-3xl mx-auto">
                <Composer
                  running={false}
                  model={model}
                  tip={modelTip}
                  files={files}
                  input={input}
                />
              </div>
            </div>
            {suggestions.length > 0 && (
              <div className="w-full max-w-2xl mx-auto mt-2">
                <div className="mx-5">
                  <div className="mb-1 flex gap-1 items-center text-xs text-gray-600 dark:text-gray-400">
                    <BoltIcon
                      className="size-3"
                      strokeWidth={2}
                      aria-hidden="true"
                    />{" "}
                    Suggested
                  </div>
                  {suggestions.map((s) => (
                    <ThreadPrimitive.Suggestion
                      key={s.prompt}
                      prompt={s.prompt}
                      send
                      disabled={files.busy}
                      className="group flex flex-col w-full text-left leading-snug px-2.5 py-1.5 rounded-lg"
                    >
                      <span className="text-sm text-gray-900 group-hover:text-gray-950 dark:text-gray-300 dark:group-hover:text-white line-clamp-1">
                        {s.title}
                      </span>
                      <span className="text-xs text-gray-600 group-hover:text-gray-900 dark:text-gray-400 dark:group-hover:text-gray-100 line-clamp-1">
                        {s.hint}
                      </span>
                    </ThreadPrimitive.Suggestion>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <ThreadPrimitive.Root className="@container flex-1 min-h-0 flex flex-col">
            <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto pt-6">
              <AskActions.Provider value={{ allow, deny }}>
                <ThreadPrimitive.Messages
                  components={{ UserMessage, AssistantMessage }}
                />
              </AskActions.Provider>
            </ThreadPrimitive.Viewport>
            <Composer
              running={running}
              model={model}
              tip={modelTip}
              files={files}
              input={input}
            />
          </ThreadPrimitive.Root>
        )}
      </div>
    </AssistantRuntimeProvider>
  );
}
