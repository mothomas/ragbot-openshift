"use client";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  ExclamationCircleIcon,
  InformationCircleIcon,
  MinusCircleIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import dynamic from "next/dynamic";
import { Dialog } from "radix-ui";
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useRef,
  useState,
} from "react";
import {
  askLabel,
  stepLabel,
  type Ask,
  type Block,
  type Source,
  type Step,
} from "@/lib/chat";
import { useDocuments } from "@/lib/data";
import { fileKind } from "@/lib/filetype";
import { handBack } from "@/lib/focus";
import { fmt, seconds } from "@/lib/format";
import { boot } from "@/lib/frappe";
import { DRIVE, KB_TOOL } from "@/lib/peers";

const ChartBlock = dynamic(() => import("./ChartBlock"), {
  ssr: false,
  loading: () => <div className="h-56" />,
});
// React's own lazy, not next/dynamic: the fallback needs the text, which next/dynamic's does not receive
const Answer = lazy(() => import("./Markdown"));

export function MarkdownText({ text }: { text: string }) {
  return (
    <div className="markdown-prose">
      {/* the message reads from the frame it appears in; the renderer arriving only formats what is there */}
      <Suspense fallback={<p>{text}</p>}>
        <Answer text={text} />
      </Suspense>
    </div>
  );
}

type Work = {
  steps: Step[];
  status: string;
  startedAt: number;
  answerAt?: number;
  endedAt?: number;
};

export function WorkPart({ data }: { data: Work }) {
  const { steps, status, startedAt, answerAt, endedAt } = data;
  const working = status === "running" && answerAt === undefined;
  if (!working && steps.length === 0) return null;
  const current = steps.at(-1);
  // while it works the label is the step it is on; past that, lib/chat.ts has set answerAt or endedAt
  const took = seconds(((answerAt ?? endedAt ?? startedAt) - startedAt) / 1000);
  const searched = steps.every((s) => s.name === KB_TOOL);
  const did = searched
    ? steps.length === 1
      ? "Searched once"
      : `Searched ${steps.length} times`
    : steps.length === 1
      ? "Used 1 tool"
      : `Used ${steps.length} tools`;
  const label = working
    ? current
      ? stepLabel(current)
      : "Thinking…"
    : `${did} · ${took}`;
  return (
    <details className="group mb-2 text-[0.9375rem] text-gray-600 dark:text-gray-400">
      <summary className="flex items-center gap-1.5 cursor-pointer list-none w-fit">
        <span className={working ? "shimmer" : ""}>{label}</span>
        {steps.length > 0 && (
          <ChevronDownIcon
            className="size-3.5 transition group-open:rotate-180"
            strokeWidth={2}
          />
        )}
      </summary>
      <ol className="mt-1.5 ml-1 border-l border-gray-200 dark:border-gray-800 pl-3 space-y-1">
        {steps.map((s, i) => (
          <li key={i}>{stepLabel(s)}</li>
        ))}
      </ol>
    </details>
  );
}

// the buttons live inside assistant-ui's part list, which is given components rather than props
export const AskActions = createContext<{
  allow: (id: string) => void;
  deny: (id: string) => void;
}>({ allow: () => {}, deny: () => {} });

// Open WebUI v0.11.3's ToolCallDisplay while a tool waits on its user: the Allow header, the call's
// arguments under Input, and the two buttons. Everything a user reads here is its en-US wording.
export function AskPart({ data: ask }: { data: Ask }) {
  const { allow, deny } = useContext(AskActions);
  const [sent, setSent] = useState(false);
  const waiting = ask.state === "waiting" && !sent;
  const answer = (act: (id: string) => void) => () => {
    setSent(true); // one answer per card: the server refuses the second, and the loser reads that
    act(ask.id);
  };
  return (
    <section
      aria-label={askLabel(ask)}
      className="border border-gray-50 dark:border-gray-850/30 rounded-2xl my-1.5 p-2.5 space-y-2"
    >
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0 line-clamp-1 text-sm text-black dark:text-white">
          {askLabel(ask)}
        </div>
        {ask.state !== "denied" && (
          <span className="flex gap-1 shrink-0">
            <button
              type="button"
              disabled={!waiting}
              onClick={answer(allow)}
              className="text-[0.6875rem] px-2.5 py-0.5 rounded-md text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-white/8 hover:bg-gray-200 dark:hover:bg-white/12 transition-colors duration-100 disabled:opacity-50"
            >
              Allow
            </button>
            <button
              type="button"
              disabled={!waiting}
              onClick={answer(deny)}
              className="text-[0.6875rem] px-2 py-0.5 rounded-md text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-300 transition-colors duration-100 disabled:opacity-50"
            >
              Deny
            </button>
          </span>
        )}
      </div>
      <div>
        <div className="text-[0.625rem] uppercase tracking-wider text-gray-600 dark:text-gray-400 mb-1.5 px-1">
          Input
        </div>
        <dl className="px-1 space-y-0.5">
          {Object.entries(ask.arguments).map(([k, v]) => (
            <div key={k} className="flex gap-2 text-xs py-0.5">
              <dt className="text-gray-600 dark:text-gray-400 shrink-0">{k}</dt>
              <dd className="text-gray-800 dark:text-gray-200 break-all">
                {typeof v === "string" ? v : JSON.stringify(v)}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      {ask.message && <ErrorPart data={{ message: ask.message }} />}
    </section>
  );
}

// Open WebUI v0.11.3 reports a failed answer in a quiet grey box, not in red
export function ErrorPart({ data }: { data: { message: string } }) {
  return (
    <div
      role="alert"
      className="my-1.5 flex w-full items-start gap-2 rounded-2xl bg-black/[0.03] px-3 py-2 text-gray-600 dark:bg-white/[0.04] dark:text-gray-400"
    >
      <InformationCircleIcon
        className="mt-0.5 size-4 shrink-0 text-gray-600 dark:text-gray-400"
        strokeWidth={1.8}
        aria-hidden="true"
      />
      <div className="min-w-0 break-words text-[0.8125rem] leading-5">
        {data.message}
      </div>
    </div>
  );
}

type Metric = {
  label: string;
  value: number | string;
  format?: string;
  trend?: "up" | "down" | "flat";
  trend_value?: string;
};
type Column = { key: string; label: string; format?: string };
type Row = { values: Record<string, unknown> };

// A block's title reads like the h3 an answer would use for it
const caption =
  "text-base leading-snug font-medium text-gray-900 dark:text-white mb-1.5";

// Measured from Open WebUI v0.11.3's markdown tables
export function Table({
  title,
  columns,
  rows,
  currency,
}: {
  title?: string;
  columns: Column[];
  rows: Row[];
  currency?: string;
}) {
  return (
    <figure className="my-3">
      {title && <figcaption className={caption}>{title}</figcaption>}
      <div className="overflow-x-auto max-w-full">
        <table className="w-full text-xs text-left text-gray-600 dark:text-gray-400">
          <thead className="uppercase text-gray-900 dark:text-white">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className="px-2.5 py-2 font-medium border-b border-gray-100 dark:border-gray-800"
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={i}
                className="border-b border-gray-50 dark:border-gray-850 last:border-0"
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className="px-3 py-2 text-gray-900 dark:text-white"
                  >
                    {fmt(
                      r.values[c.key],
                      c.format,
                      currency ?? boot().currency,
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

const STATUS: Record<string, [typeof CheckCircleIcon, string]> = {
  green: [CheckCircleIcon, "text-green-700 dark:text-green-400"],
  red: [ExclamationCircleIcon, "text-red-700 dark:text-red-400"],
  yellow: [InformationCircleIcon, "text-yellow-700 dark:text-yellow-400"],
  blue: [InformationCircleIcon, "text-blue-700 dark:text-blue-400"],
  gray: [MinusCircleIcon, "text-gray-600 dark:text-gray-400"],
};

const TREND = { up: "Up", down: "Down", flat: "No change" };

// One headline figure, on the surface Open WebUI gives a user's message; values are always text
function Kpi({
  label,
  value,
  note,
  children,
}: {
  label: string;
  value: string;
  note?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl bg-gray-50 dark:bg-gray-850 px-3.5 py-2.5">
      <dt className="text-xs text-gray-600 dark:text-gray-400">{label}</dt>
      <dd className="text-xl text-gray-900 dark:text-white">{value}</dd>
      {note && (
        <dd className="text-xs text-gray-600 dark:text-gray-400">{note}</dd>
      )}
      {children}
    </div>
  );
}

export function BlockPart({ data: b }: { data: Block }) {
  if (b.type === "kpi") {
    return (
      <dl className="my-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
        {((b.metrics as Metric[]) ?? []).map((m) => (
          <Kpi
            key={m.label}
            label={m.label}
            value={fmt(m.value, m.format, boot().currency)}
            note={m.trend && `${TREND[m.trend]} ${m.trend_value ?? ""}`.trim()}
          />
        ))}
      </dl>
    );
  }
  if (b.type === "table")
    return (
      <Table
        title={b.title as string}
        columns={b.columns as Column[]}
        rows={b.rows as Row[]}
      />
    );
  if (b.type === "status_list") {
    return (
      <figure className="my-3">
        {typeof b.title === "string" && (
          <figcaption className={caption}>{b.title}</figcaption>
        )}
        <ul className="space-y-1 text-sm">
          {(
            (b.items as { label: string; status: string; color: string }[]) ??
            []
          ).map((it) => {
            const [Icon, tone] = STATUS[it.color] ?? STATUS.gray;
            return (
              <li key={it.label} className="flex items-center gap-2">
                <Icon
                  className={`size-4 shrink-0 ${tone}`}
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
                <span className="flex-1">{it.label}</span>
                <span className={tone}>{it.status}</span>
              </li>
            );
          })}
        </ul>
      </figure>
    );
  }
  if (b.type === "chart") return <ChartBlock block={b} />;
  return null;
}

// Sources are what the assistant read, not what supports the answer: no distance cutoff separates relevant
// passages from irrelevant ones, so none is filtered out or banded green-to-red as if it carried a confidence.
const relevance = (s: Source) => (s.distance === null ? null : 1 - s.distance);

// The source badge in the file's own type colour. Whole class names, because Tailwind reads the source;
// the wash is what the badge's grey number still reads on — 12% light and 20% dark were measured.
const TYPE_TINT: Record<ReturnType<typeof fileKind>, string> = {
  pdf: "bg-type-pdf/12 dark:bg-type-pdf/20",
  doc: "bg-type-doc/12 dark:bg-type-doc/20",
  sheet: "bg-type-sheet/12 dark:bg-type-sheet/20",
  slides: "bg-type-slides/12 dark:bg-type-slides/20",
  other: "bg-type-other/12 dark:bg-type-other/20",
};

// the pill shares its row with whatever follows it (the answer's buttons); the list opens below the row
export function SourcesPart({
  data,
  children,
}: {
  data: { items: Source[] };
  children?: React.ReactNode;
}) {
  const { docs } = useDocuments();
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  // the source that opened the passages takes the focus back when they close
  const opener = useRef<HTMLButtonElement | null>(null);
  const attached = new Map(
    data.items
      .filter((s) => s.attachment)
      .map((s) => [s.file, s.file_name ?? "Attached file"]),
  );
  const title = (file: string) =>
    attached.get(file) ??
    docs?.find((d) => d.name === file)?.file_name ??
    "Document";
  const best = (ps: Source[]) => Math.max(...ps.map((p) => relevance(p) ?? 0));
  const files = [...Map.groupBy(data.items, (s) => s.file)].sort(
    ([, a], [, b]) => best(b) - best(a),
  );
  const passages = [...(files.find(([f]) => f === shown)?.[1] ?? [])].sort(
    (a, b) => (relevance(b) ?? 0) - (relevance(a) ?? 0),
  );
  const count = files.length === 1 ? "1 Source" : `${files.length} Sources`;

  return (
    <>
      <div className="py-1 -mx-0.5 flex items-center gap-1">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`Toggle ${count.toLowerCase()}`}
          className="text-xs text-gray-600 dark:text-gray-300 px-3.5 h-8 rounded-full border border-gray-50 dark:border-gray-850/30 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
        >
          {count}
        </button>
        {children}
      </div>
      {open && (
        <ol className="py-1.5 text-xs flex flex-col gap-2">
          {files.map(([file], i) => (
            <li key={file}>
              <button
                onClick={(e) => {
                  opener.current = e.currentTarget;
                  setShown(file);
                }}
                className="w-full flex gap-1.5 items-center text-gray-600 dark:text-gray-300"
              >
                <span
                  className={`rounded-md px-1 ${TYPE_TINT[fileKind(title(file))]}`}
                >
                  {i + 1}
                </span>
                <span className="flex-1 truncate text-left hover:text-black dark:text-white/60 dark:hover:text-white">
                  {title(file)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <Dialog.Root
        open={shown !== null}
        onOpenChange={(o) => !o && setShown(null)}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 dark:bg-black/60" />
          <Dialog.Content
            onCloseAutoFocus={(e) => handBack(e, opener)}
            className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[56rem] max-w-[calc(100%-1rem)] rounded-4xl bg-white dark:bg-gray-900 border border-white dark:border-gray-850"
          >
            <div className="flex justify-between items-center px-4.5 pt-3 pb-2 dark:text-gray-300">
              <Dialog.Title className="text-sm font-medium">
                {/* a file attached in this chat is not in Drive, so it has nowhere to link */}
                {shown && attached.has(shown) && (
                  <span className="line-clamp-1">{title(shown)}</span>
                )}
                {shown && !attached.has(shown) && (
                  <a
                    href={DRIVE.page(shown)}
                    target="_blank"
                    rel="noreferrer"
                    className="underline hover:text-gray-900 dark:hover:text-gray-100 line-clamp-1"
                  >
                    {title(shown)}
                  </a>
                )}
              </Dialog.Title>
              <Dialog.Close
                aria-label="Close"
                className="rounded-lg p-1 text-gray-600 hover:bg-gray-50 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
              >
                <XMarkIcon className="size-4" />
              </Dialog.Close>
            </div>
            <Dialog.Description className="sr-only">
              What the assistant read from this document, most relevant first.
            </Dialog.Description>
            <ul className="px-5 pb-5 max-h-[22rem] overflow-y-auto flex flex-col gap-3 dark:text-gray-200">
              {passages.map((p) => (
                <li key={p.seq}>
                  <div className="text-sm dark:text-gray-300 flex items-center gap-2 mb-1">
                    Content
                    {relevance(p) !== null && (
                      <span
                        className="px-1 rounded-sm bg-gray-50 dark:bg-gray-850 text-gray-700 dark:text-gray-300"
                        title="Relevance"
                      >
                        <span className="sr-only">Relevance </span>
                        {((relevance(p) as number) * 100).toFixed(2)}%
                      </span>
                    )}
                  </div>
                  <p className="text-sm whitespace-pre-line text-gray-700 dark:text-gray-300">
                    {/* "" is a passage rag would not hand back to this reader; undefined, one not asked for */}
                    {p.content === "" ? "No source available" : p.content}
                  </p>
                </li>
              ))}
            </ul>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

// Open WebUI's menu and confirm dialog, shared by the chat list and Documents
export const MENU =
  "z-50 min-w-52 rounded-2xl p-1 bg-white dark:bg-gray-850 shadow-lg border border-gray-100 dark:border-gray-800 text-[13px] text-gray-800 dark:text-gray-100";
export const MENU_ITEM =
  "px-3 py-1.5 rounded-xl outline-hidden data-highlighted:bg-gray-50 dark:data-highlighted:bg-gray-800";
export const CANCEL =
  "text-sm bg-gray-100 hover:bg-gray-100/70 text-gray-800 dark:bg-gray-850 dark:hover:bg-gray-850/60 dark:text-white w-full py-1.5 rounded-full transition";
export const CONFIRM =
  "text-sm bg-gray-900 hover:bg-gray-900/90 text-gray-100 dark:bg-gray-100 dark:hover:bg-gray-100/90 dark:text-gray-800 w-full py-1.5 rounded-full transition disabled:opacity-60";

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  onCloseAutoFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  // required: Modal renders no <Dialog.Trigger>, so Radix has nothing to give the focus back to
  onCloseAutoFocus: (e: Event) => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          onCloseAutoFocus={onCloseAutoFocus}
          className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[32rem] max-w-[calc(100%-1rem)] rounded-3xl bg-white dark:bg-gray-950 border border-white dark:border-gray-900 shadow-3xl px-5 py-5"
        >
          <Dialog.Title className="text-base font-medium dark:text-gray-200 mb-2.5">
            {title}
          </Dialog.Title>
          <Dialog.Description
            className={
              description
                ? "text-sm text-gray-600 dark:text-gray-400"
                : "sr-only"
            }
          >
            {description ?? title}
          </Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Open WebUI's dark tooltip, below its anchor or above it near the window's bottom. The ::before is
// a transparent hit area over the gap, so the pointer can rest on the tooltip (SC 1.4.13); its 5px
// is mt-1/mb-1 plus the border, the distance back to the anchor's edge. "tip" is what Escape hides.
const TIP_BOX =
  "tip invisible opacity-0 group-hover/tip:visible group-hover/tip:opacity-100 group-focus-within/tip:visible group-focus-within/tip:opacity-100 transition-opacity absolute z-10 whitespace-nowrap rounded-lg border border-gray-900 bg-gray-950 px-2.5 py-1.5 text-xs text-white shadow-xl before:absolute before:inset-x-0 before:h-[5px]";
export const TIP = `${TIP_BOX} top-full mt-1 before:-top-[5px]`;
export const TIP_ABOVE = `${TIP_BOX} bottom-full mb-1 before:-bottom-[5px]`;

export function NoSourcesPart() {
  return (
    <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
      Nothing in your documents matched this question.
    </p>
  );
}
