"use client";
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowRightCircleIcon,
  ArrowsUpDownIcon,
  ArrowTopRightOnSquareIcon,
  ArrowUpTrayIcon,
  CheckIcon,
  ChatBubbleLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  EllipsisHorizontalIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  FolderIcon,
  FolderPlusIcon,
  ListBulletIcon,
  MagnifyingGlassIcon,
  PencilSquareIcon,
  Squares2X2Icon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { Dialog, DropdownMenu } from "radix-ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { announce, noteIndexing } from "@/lib/announce";
import { familyOf, getPref, setPref, splitName } from "@/lib/documents";
import { handBack, successor, useHandover } from "@/lib/focus";
import { bytes, fromServer } from "@/lib/format";
import {
  boot,
  driveUpload,
  FrappeError,
  get,
  post,
  requestId,
} from "@/lib/frappe";
import { DRIVE } from "@/lib/peers";
import { usePoll } from "@/lib/poll";
import { FileIcon } from "./FileIcons";
import { CANCEL, CONFIRM, MENU, MENU_ITEM, Modal, TIP } from "./parts";

type Item = {
  name: string;
  title: string;
  is_folder: boolean;
  size: number | null;
  modified: string | null;
  // Drive's file_type: PDF, Text, Image, Document (a Drive document), ...
  type?: string | null;
  owner?: string | null;
  owner_name?: string | null;
  children: number | null;
  write: boolean;
  state?: "ready" | "indexing" | "failed" | "error";
  // why the last attempt failed, shown on the state's hover; only a Retry in this tab sets it
  why?: string;
};
type Listing = {
  folder: string;
  team: string | null;
  path: { name: string; title: string }[];
  can_upload: boolean;
  items: Item[];
};
type Upload = {
  key: string;
  title: string;
  size: number;
  share: number;
  error?: string;
};
type Ask =
  | { kind: "folder" }
  | { kind: "rename"; item: Item }
  | { kind: "move"; item: Item }
  | { kind: "trash"; item: Item };

const STATE = {
  ready: "Indexed",
  indexing: "Indexing…",
  failed: "Can't read",
  error: "Indexing failed",
};
type State = keyof typeof STATE;
// IBM Carbon's status indicator: a shape and the state's own word, never colour alone. The tint is
// opaque — 8% of the state's token over the panel's own surface — so the chip's text holds 4.5:1
// whatever the row is doing underneath it. The numbers are in evidence/V4/verify-1.txt.
const CHIP: Record<State, string> = {
  ready:
    "text-state-done bg-[color-mix(in_srgb,var(--color-state-done)_8%,white)] dark:bg-[color-mix(in_srgb,var(--color-state-done)_8%,var(--color-gray-900))]",
  indexing:
    "text-state-working bg-[color-mix(in_srgb,var(--color-state-working)_8%,white)] dark:bg-[color-mix(in_srgb,var(--color-state-working)_8%,var(--color-gray-900))]",
  failed:
    "text-state-stuck bg-[color-mix(in_srgb,var(--color-state-stuck)_8%,white)] dark:bg-[color-mix(in_srgb,var(--color-state-stuck)_8%,var(--color-gray-900))]",
  error:
    "text-state-stuck bg-[color-mix(in_srgb,var(--color-state-stuck)_8%,white)] dark:bg-[color-mix(in_srgb,var(--color-state-stuck)_8%,var(--color-gray-900))]",
};
const STATE_ICON: Record<State, typeof CheckIcon> = {
  ready: CheckIcon,
  indexing: ArrowPathIcon,
  failed: ExclamationTriangleIcon,
  error: ExclamationTriangleIcon,
};
// Drive's columns, dropped as the list narrows: Owner and Size below 42rem, Modified below 28rem.
// The state column holds the widest chip, "Indexing failed", and the Retry beside it.
const COLS =
  "grid grid-cols-[minmax(0,1fr)_11rem_2rem] @md:grid-cols-[minmax(0,1fr)_11rem_7rem_2rem] @2xl:grid-cols-[minmax(0,1fr)_11rem_8rem_7rem_5rem_2rem] items-center gap-3";
const MID = "hidden @md:block";
const WIDE = "hidden @2xl:block";
const VIEWS = ["list", "tiles"] as const;
const DENSITIES = ["comfortable", "compact"] as const;
type View = (typeof VIEWS)[number];
type Density = (typeof DENSITIES)[number];
const VIEW_LABEL: Record<View, string> = {
  list: "List view",
  tiles: "Tile view",
};
const DENSITY_LABEL: Record<Density, string> = {
  comfortable: "Comfortable",
  compact: "Compact",
};
const ROW_HEIGHT: Record<Density, string> = {
  comfortable: "h-11",
  compact: "h-8",
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
// Drive's own label: "You" for your files, else the owner's full name
const ownerOf = (i: Item) =>
  !i.owner ? "" : i.owner === boot().user ? "You" : i.owner_name || i.owner;

const date = (s: string | null) => {
  if (!s) return "";
  const d = fromServer(s, boot().time_zone);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(
    undefined,
    sameYear
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  );
};

// The middle of a long name gives way so the extension survives, in both views. CSS does the
// shortening, so it follows the column as it narrows and nothing has to be measured in script.
function Name({
  title,
  className = "",
}: {
  title: string;
  className?: string;
}) {
  const [stem, ext] = splitName(title);
  return (
    <span className={`flex min-w-0 ${className}`} title={title}>
      <span className="truncate">{stem}</span>
      {ext && <span className="shrink-0">{ext}</span>}
    </span>
  );
}

// Drive's upload reports real progress (lib/frappe.ts: xhr.upload.onprogress); the indexer reports
// none — rag.ingest.index_state answers a state and no fraction — so indexing is indeterminate.
// The bar is named by the text beside it, so it adds no words of its own.
function Bar({ share, labelId }: { share?: number; labelId: string }) {
  const known = share !== undefined;
  return (
    <span
      role="progressbar"
      aria-labelledby={labelId}
      aria-valuenow={known ? Math.round(share * 100) : undefined}
      className="block h-[3px] w-full max-w-28 overflow-hidden rounded-full outline-1 outline-gray-600 dark:outline-gray-400 bg-gray-200 dark:bg-gray-800"
    >
      <span
        className="block h-full rounded-full bg-state-working"
        style={{ width: known ? `${Math.round(share * 100)}%` : "100%" }}
      />
    </span>
  );
}

// A file on its way up: Drive's own share, and the bar named by the words beside it.
function Uploading({
  upload: u,
  className = "",
  centred = false,
}: {
  upload: Upload;
  className?: string;
  centred?: boolean;
}) {
  const labelId = useId();
  return (
    <span
      className={`flex min-w-0 max-w-full flex-col gap-1 ${centred ? "items-center" : ""}`}
    >
      <span
        id={labelId}
        title={u.error}
        className={`max-w-full truncate ${className} ${u.error ? "text-red-600 dark:text-red-400" : "text-gray-600 dark:text-gray-400"}`}
      >
        {u.error ? "Upload failed" : `Uploading ${Math.round(u.share * 100)}%`}
        {u.error && <span className="sr-only">. {u.error}</span>}
      </span>
      {!u.error && <Bar share={u.share} labelId={labelId} />}
    </span>
  );
}

// A file's indexing state: the icon, the state's own word, and — only where running it again can
// help — the same Retry the file's ⋯ menu offers.
function Indexing({
  item,
  onRetry,
  centred = false,
}: {
  item: Item;
  onRetry: () => void;
  centred?: boolean;
}) {
  // the bar is named by the word beside it, so the word needs an id of its own: React's, never the
  // file's name, which may hold the spaces that would split an aria-labelledby into three references
  const labelId = useId();
  const state = item.state ?? "failed";
  const Icon = STATE_ICON[state];
  return (
    <span
      className={`flex min-w-0 max-w-full flex-col gap-1 ${centred ? "items-center" : ""}`}
    >
      {/* a tile is narrower than "Indexing failed" and its Retry, so there the two wrap */}
      <span
        className={`flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 ${centred ? "justify-center" : ""}`}
      >
        <span
          id={labelId}
          title={item.why}
          className={`inline-flex min-w-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-xs ${CHIP[state]}`}
        >
          <Icon
            className={`size-3.5 shrink-0 ${state === "indexing" ? "animate-spin motion-reduce:animate-none" : ""}`}
            aria-hidden="true"
          />
          <span className="truncate">{STATE[state]}</span>
          {state !== "indexing" && item.why && (
            <span className="sr-only">. {item.why}</span>
          )}
        </span>
        {state === "error" && (
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 rounded-full px-1.5 py-0.5 text-xs text-gray-700 hover:bg-black/5 dark:text-gray-300 dark:hover:bg-white/5"
          >
            Retry
          </button>
        )}
      </span>
      {state === "indexing" && <Bar labelId={labelId} />}
    </span>
  );
}

// Open WebUI's view filter, by who made the item
const SCOPES = {
  all: "All",
  mine: "Created by you",
  shared: "Shared with you",
} as const;
type Scope = keyof typeof SCOPES;
// Sortable columns and the way each sorts on its first click (Apple HIG; Open WebUI's setSortKey)
type Sort = { key: "title" | "modified" | "size"; asc: boolean };
const FIRST_ASC: Record<Sort["key"], boolean> = {
  title: true,
  modified: false,
  size: false,
};
const byName = (a: Item, b: Item) =>
  a.title.localeCompare(b.title, undefined, {
    numeric: true,
    sensitivity: "base",
  });
// Folders stay on top, A to Z unless the name sort is reversed; files follow the chosen column
function arrange(
  items: Item[],
  { key, asc }: Sort,
): { folders: Item[]; files: Item[] } {
  const dir = asc ? 1 : -1;
  const by = (a: Item, b: Item) =>
    key === "title"
      ? byName(a, b)
      : key === "size"
        ? (a.size ?? 0) - (b.size ?? 0)
        : (a.modified ?? "").localeCompare(b.modified ?? "");
  return {
    folders: items
      .filter((i) => i.is_folder)
      .sort((a, b) => byName(a, b) * (key === "title" ? dir : 1)),
    files: items
      .filter((i) => !i.is_folder)
      .sort((a, b) => by(a, b) * dir || byName(a, b)),
  };
}

// A folder picker for Move to…: Drive's own listing, folders only
function MoveTo({
  item,
  onMove,
  onCancel,
}: {
  item: Item;
  onMove: (target: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [at, setAt] = useState("");
  const [here, setHere] = useState<Listing | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true; // a folder clicked before the last one answered must not have its listing replaced
    get<Listing>("rag.library.folder", { folder: at })
      .then((l) => live && setHere(l))
      .catch(() => live && setHere(null));
    return () => void (live = false);
  }, [at]);
  const folders =
    here?.items
      .filter((i) => i.is_folder && i.write && i.name !== item.name)
      .sort(byName) ?? [];
  return (
    <>
      <nav
        aria-label="Folder"
        className="mt-3 flex flex-wrap items-center gap-1 text-sm"
      >
        {here?.path.map((p, i) => (
          <span key={p.name} className="flex items-center gap-1">
            {i > 0 && (
              <ChevronRightIcon
                className="size-3.5 text-gray-600 dark:text-gray-400"
                aria-hidden="true"
              />
            )}
            <button
              onClick={() => setAt(p.name)}
              className={
                i === here.path.length - 1
                  ? "text-gray-900 dark:text-gray-100"
                  : "text-gray-600 dark:text-gray-400 hover:underline"
              }
            >
              {p.title}
            </button>
          </span>
        ))}
      </nav>
      <ul className="mt-2 max-h-56 overflow-y-auto rounded-2xl border border-gray-100 dark:border-gray-850">
        {folders.length === 0 && (
          <li className="px-3 py-2 text-sm text-gray-600 dark:text-gray-400">
            No folders here
          </li>
        )}
        {folders.map((f) => (
          <li key={f.name}>
            <button
              onClick={() => setAt(f.name)}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-left text-gray-900 dark:text-gray-100 hover:bg-black/5 dark:hover:bg-white/5"
            >
              <FolderIcon
                className="size-4 text-gray-600 dark:text-gray-400"
                aria-hidden="true"
              />
              {f.title}
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-5 flex justify-between gap-1.5">
        <button onClick={onCancel} className={CANCEL}>
          Cancel
        </button>
        <button
          disabled={busy || !here || here.folder === item.name}
          onClick={() => {
            setBusy(true);
            onMove(here!.folder).finally(() => setBusy(false));
          }}
          className={CONFIRM}
        >
          Move here
        </button>
      </div>
    </>
  );
}

// Drive serves a file inline unless asked to download it, so a PDF opens in the browser's own viewer;
// the preview address (rag.preview) ends in the file's name, which the viewer shows as its title
const content = (item: Item) =>
  `/ask/files/${encodeURIComponent(item.name)}/${encodeURIComponent(item.title)}`;
const download = (name: string) =>
  `/api/method/${DRIVE.content}?entity_name=${encodeURIComponent(name)}&trigger_download=1`;
const TEXT_LIMIT = 2 * 1024 * 1024; // ponytail: whole-file fetch; page through larger text if people keep big logs in Drive

const none = (
  <div className="grid h-full place-items-center text-center">
    <div>
      <p className="text-gray-900 dark:text-gray-100">No preview available</p>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        Open it in Drive or download it.
      </p>
    </div>
  </div>
);

// A text file's own contents; it is keyed by the file, so each one loads into a preview of its own
function TextFile({ item }: { item: Item }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true; // a file closed before its text arrived must not fill the next one's preview
    fetch(content(item), { headers: requestId() })
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then((t) => live && setText(t))
      .catch(() => live && setFailed(true));
    return () => void (live = false);
  }, [item]);
  if (text !== null)
    return (
      <pre className="h-full overflow-auto whitespace-pre-wrap rounded-xl border border-gray-100 dark:border-gray-850 px-4 py-3 font-sans text-sm leading-6 text-gray-900 dark:text-gray-100">
        {text}
      </pre>
    );
  return failed ? (
    none
  ) : (
    <p className="text-sm text-gray-600 dark:text-gray-400">Loading…</p>
  );
}

// The file itself, from Drive, in a dialog: a PDF in the browser's viewer, an image, or text
function Preview({
  item,
  onClose,
  onCloseAutoFocus,
}: {
  item: Item | null;
  onClose: () => void;
  onCloseAutoFocus: (e: Event) => void;
}) {
  const readable = item?.type === "Text" && (item.size ?? 0) <= TEXT_LIMIT;
  const icon =
    "relative group/tip grid place-items-center size-8 rounded-xl text-gray-600 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/5";
  return (
    <Dialog.Root open={!!item} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        {/* the control that opened it takes focus back: the file's name, or its ⋯ when opened from the menu */}
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
          className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[56rem] max-w-[calc(100%-1rem)] h-[85dvh] flex flex-col rounded-3xl bg-white dark:bg-gray-950 border border-white dark:border-gray-900 shadow-3xl"
        >
          {item && (
            <>
              <div className="flex items-center gap-2 px-5 pt-4 pb-3">
                <FileIcon
                  family={familyOf(item.type, item.title)}
                  className="size-5 shrink-0"
                />
                <Dialog.Title className="flex-1 min-w-0 truncate text-base font-medium dark:text-gray-200">
                  {item.title}
                </Dialog.Title>
                <a
                  href={DRIVE.page(item.name)}
                  target="_blank"
                  rel="noopener"
                  aria-label="Open in Drive"
                  className={icon}
                >
                  <ArrowTopRightOnSquareIcon
                    className="size-4"
                    strokeWidth={1.5}
                  />
                  <span aria-hidden="true" className={`${TIP} right-0`}>
                    Open in Drive
                  </span>
                </a>
                <a
                  href={download(item.name)}
                  aria-label="Download"
                  className={icon}
                >
                  <ArrowDownTrayIcon className="size-4" strokeWidth={1.5} />
                  <span aria-hidden="true" className={`${TIP} right-0`}>
                    Download
                  </span>
                </a>
                <Dialog.Close aria-label="Close" className={icon}>
                  <XMarkIcon className="size-4" />
                </Dialog.Close>
              </div>
              <div className="flex-1 min-h-0 px-5 pb-5">
                {item.type === "PDF" ? (
                  <iframe
                    src={content(item)}
                    title={item.title}
                    className="size-full rounded-xl border border-gray-100 dark:border-gray-850"
                  />
                ) : item.type === "Image" ? (
                  <img
                    src={content(item)}
                    alt={item.title}
                    className="size-full object-contain"
                  />
                ) : readable ? (
                  <TextFile key={item.name} item={item} />
                ) : (
                  none
                )}
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RowMenu({
  item,
  onAsk,
  onAct,
  onPreview,
  onRetry,
}: {
  item: Item;
  onAsk: () => void;
  onAct: (a: Ask, from: HTMLElement | null) => void;
  onPreview: (opener: HTMLElement | null) => void;
  onRetry: () => void;
}) {
  const link = DRIVE.page(item.name, item.is_folder);
  const trigger = useRef<HTMLButtonElement>(null);
  const row = `${MENU_ITEM} flex items-center gap-2`;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        ref={trigger}
        data-menu=""
        aria-label={`More options for ${item.title}`}
        className="grid place-items-center size-7 rounded-lg text-gray-600 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/5 data-[state=open]:bg-black/5 dark:data-[state=open]:bg-white/5"
      >
        <EllipsisHorizontalIcon className="size-4" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" className={MENU}>
          {!item.is_folder && (
            <DropdownMenu.Item
              onSelect={() => onPreview(trigger.current)}
              className={row}
            >
              <EyeIcon className="size-4" strokeWidth={1.5} /> Preview
            </DropdownMenu.Item>
          )}
          {!item.is_folder && (
            <DropdownMenu.Item onSelect={onAsk} className={row}>
              <ChatBubbleLeftIcon className="size-4" strokeWidth={1.5} /> Ask
              about this
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item
            onSelect={() => window.open(link, "_blank", "noopener")}
            className={row}
          >
            <ArrowTopRightOnSquareIcon className="size-4" strokeWidth={1.5} />{" "}
            Open in Drive
          </DropdownMenu.Item>
          {!item.is_folder && (
            <DropdownMenu.Item
              onSelect={() => location.assign(download(item.name))}
              className={row}
            >
              <ArrowDownTrayIcon className="size-4" strokeWidth={1.5} />{" "}
              Download
            </DropdownMenu.Item>
          )}
          {item.state === "error" && (
            <DropdownMenu.Item onSelect={onRetry} className={row}>
              <ArrowPathIcon className="size-4" strokeWidth={1.5} /> Retry
            </DropdownMenu.Item>
          )}
          {item.write && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-gray-100 dark:bg-gray-800" />
              <DropdownMenu.Item
                onSelect={() =>
                  onAct({ kind: "rename", item }, trigger.current)
                }
                className={row}
              >
                <PencilSquareIcon className="size-4" strokeWidth={1.5} /> Rename
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() => onAct({ kind: "move", item }, trigger.current)}
                className={row}
              >
                <ArrowRightCircleIcon className="size-4" strokeWidth={1.5} />{" "}
                Move to…
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-gray-100 dark:bg-gray-800" />
              <DropdownMenu.Item
                onSelect={() => onAct({ kind: "trash", item }, trigger.current)}
                className={`${row} text-red-600 dark:text-red-400`}
              >
                <TrashIcon className="size-4" strokeWidth={1.5} /> Move to Trash
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// actionsSlot: the top bar's spot before the round trip, where the search and actions go when it is wide enough
type Props = {
  folder: string;
  onOpen: (folder: string) => void;
  onAsk: (question: string) => void;
  onChanged: () => void;
  actionsSlot: HTMLElement | null;
};

// The Documents window is Drive's front end: every change is one of Drive's own calls, so Drive
// keeps its permissions and trash, and search follows Drive through rag's File hooks.
export default function Documents({
  folder,
  onOpen,
  onAsk,
  onChanged,
  actionsSlot,
}: Props) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const [failed, setFailed] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [preview, setPreview] = useState<Item | null>(null);
  const [scope, setScope] = useState<Scope>("all");
  const [sort, setSort] = useState<Sort>({ key: "modified", asc: false });
  // list is the default; both choices live in this browser, as lib/theme.ts keeps the colour mode
  const [view, setView] = useState<View>(() =>
    getPref("documents-view", VIEWS, "list"),
  );
  const [density, setDensity] = useState<Density>(() =>
    getPref("documents-density", DENSITIES, "comfortable"),
  );
  // a ref, not state: closing clears the preview before the dialog hands focus back
  const opener = useRef<HTMLElement | null>(null);
  const backToOpener = (e: Event) => handBack(e, opener);
  const list = useRef<HTMLElement>(null);
  // the rows' ⋯ buttons in the order they are shown, and where the row a dialog acts on sits among them
  const menus = () => [
    ...(list.current?.querySelectorAll<HTMLElement>("[data-menu]") ?? []),
  ];
  const place = useRef(-1);
  const openPreview = (item: Item, from: HTMLElement | null) => {
    opener.current = from;
    setPreview(item);
  };
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const cancel = (
    <button type="button" onClick={() => setAsk(null)} className={CANCEL}>
      Cancel
    </button>
  );

  // a new folder, a new search and the indexing poll all load: only the latest request's answer is shown
  const latest = useRef(0);
  const load = useCallback(() => {
    const n = ++latest.current;
    return get<Listing>("rag.library.folder", { folder, search })
      .then((l) => {
        if (n !== latest.current) return;
        noteIndexing(l.items);
        setListing(l);
        setFailed(false);
      })
      .catch(() => {
        if (n === latest.current) setFailed(true);
      });
  }, [folder, search]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);
  // a new upload is indexed by a background job: check again until it says how it went
  const indexing = !!listing?.items.some((i) => i.state === "indexing");
  usePoll(load, 1_500, { on: indexing });

  // leaving a search for a folder clears the search itself too, not only its box, or the folder loads with it first
  const openFolder = (name: string) => {
    setQuery("");
    setSearch("");
    onOpen(name);
  };
  const changed = () => {
    onChanged();
    return load();
  };
  const open = (a: Ask, from: HTMLElement | null) => {
    opener.current = from;
    place.current = from ? menus().indexOf(from) : -1;
    setError("");
    setName(
      a.kind === "rename" ? a.item.title : a.kind === "folder" ? "" : name,
    );
    setAsk(a);
  };
  // one request at a time: a second click on Move to Trash would restore the file, since Drive's call toggles
  const [busy, setBusy] = useState(false);
  const act = (call: () => Promise<unknown>) => {
    if (busy) return Promise.resolve();
    setBusy(true);
    return call()
      .then(() => {
        setAsk(null);
        return changed();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  // Move and Move to Trash take the row whose ⋯ the dialog handed the focus back to, and it falls to
  // <body>: give it to the row that took its place. Not while the dialog is up — disabling the
  // confirm button empties the focus too — and busy clears last, so these are the rows really left.
  useHandover(busy, () => (ask ? null : successor(menus(), place.current)));

  // Retry: the file goes back to the indexer, and the poll above follows it from "indexing"
  const mark = (item: Item, state: Item["state"], why?: string) =>
    setListing(
      (l) =>
        l && {
          ...l,
          items: l.items.map((i) =>
            i.name === item.name ? { ...i, state, why } : i,
          ),
        },
    );
  const retry = (item: Item) =>
    post("rag.ingest.reindex", { file: item.name })
      .then(() => mark(item, "indexing"))
      .catch((e: Error) => mark(item, "error", e.message));

  const upload = (list: Iterable<File>) => {
    if (!listing?.team || !listing.can_upload) return;
    const { team, folder: parent } = listing;
    for (const file of list) {
      const key = crypto.randomUUID();
      setUploads((u) => [
        ...u,
        { key, title: file.name, size: file.size, share: 0 },
      ]);
      driveUpload(file, team, parent, (share) =>
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, share } : x))),
      )
        .then((name) => {
          noteIndexing([{ name, title: file.name, state: "indexing" }]);
          setUploads((u) => u.filter((x) => x.key !== key));
          return changed();
        })
        .catch((e: FrappeError) => {
          announce(`Upload failed for ${file.name}`);
          setUploads((u) =>
            u.map((x) => (x.key === key ? { ...x, error: e.message } : x)),
          );
        });
    }
  };

  const searching = search !== "";
  const mine = (i: Item) => i.owner === boot().user;
  const { folders, files } = arrange(
    (listing?.items ?? []).filter(
      (i) => scope === "all" || (scope === "mine") === mine(i),
    ),
    sort,
  );
  // What the panel has to say about the listing it just loaded, read by the empty state below and
  // by the live region. The dependency is the sentence, not the listing, which the poll rebuilds
  // every 1.5s; `search` is in it so two searches with the same count are still both announced.
  const count = folders.length + files.length;
  const narrowed = searching || scope !== "all";
  const empty = narrowed ? "No documents found" : "This folder is empty";
  const news = failed
    ? "Documents are unavailable right now."
    : !listing
      ? ""
      : count === 0 && uploads.length === 0
        ? empty
        : searching
          ? plural(count, "item")
          : "";
  useEffect(() => {
    if (news) announce(news);
  }, [news, search]);
  const sortBy = (key: Sort["key"]) =>
    setSort((s) =>
      s.key === key ? { key, asc: !s.asc } : { key, asc: FIRST_ASC[key] },
    );
  const head = (key: Sort["key"], label: string, className = "") => (
    <span
      role="columnheader"
      aria-sort={
        sort.key === key ? (sort.asc ? "ascending" : "descending") : undefined
      }
      className={className}
    >
      <button
        onClick={() => sortBy(key)}
        className="inline-flex items-center gap-1 hover:text-gray-900 dark:hover:text-gray-100"
      >
        {label}
        {sort.key === key &&
          (sort.asc ? (
            <ChevronUpIcon className="size-3" aria-hidden="true" />
          ) : (
            <ChevronDownIcon className="size-3" aria-hidden="true" />
          ))}
      </button>
    </span>
  );
  const filter = (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="flex shrink-0 items-center gap-1 h-8 px-2 rounded-xl whitespace-nowrap text-sm text-gray-700 dark:text-gray-300 hover:bg-black/5 dark:hover:bg-white/5">
        <span className="sr-only">Show: </span>
        {SCOPES[scope]}
        <ChevronDownIcon className="size-3.5" aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" className={MENU}>
          <DropdownMenu.RadioGroup
            value={scope}
            onValueChange={(v) => setScope(v as Scope)}
          >
            {(Object.keys(SCOPES) as Scope[]).map((k) => (
              <DropdownMenu.RadioItem
                key={k}
                value={k}
                className={`${MENU_ITEM} flex items-center gap-2`}
              >
                <span className="size-4">
                  <DropdownMenu.ItemIndicator>
                    <CheckIcon className="size-4" />
                  </DropdownMenu.ItemIndicator>
                </span>
                {SCOPES[k]}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
  // The list's row height, offered only in the list (an ARIA menu radio group, as Show: is).
  // Icon only, like the view switch: the words would take the width the title needs beside it.
  const densityMenu = view === "list" && (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label="Density"
        className="relative group/tip grid shrink-0 place-items-center size-8 pointer-coarse:size-11 rounded-xl text-gray-700 dark:text-gray-300 hover:bg-black/5 dark:hover:bg-white/5 data-[state=open]:bg-black/5 dark:data-[state=open]:bg-white/5"
      >
        <ArrowsUpDownIcon className="size-4" aria-hidden="true" />
        <span aria-hidden="true" className={`${TIP} right-0`}>
          Density
        </span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" className={MENU}>
          <DropdownMenu.RadioGroup
            value={density}
            onValueChange={(v) => {
              setDensity(v as Density);
              setPref("documents-density", v);
            }}
          >
            {DENSITIES.map((d) => (
              <DropdownMenu.RadioItem
                key={d}
                value={d}
                className={`${MENU_ITEM} flex items-center gap-2`}
              >
                <span className="size-4">
                  <DropdownMenu.ItemIndicator>
                    <CheckIcon className="size-4" />
                  </DropdownMenu.ItemIndicator>
                </span>
                {DENSITY_LABEL[d]}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
  // the ARIA radio group pattern: one tab stop, the arrows move and choose, 44px where a finger points
  const viewSwitch = (
    <div
      role="radiogroup"
      aria-label="View"
      className="flex shrink-0 items-center gap-0.5 p-0.5 rounded-xl bg-gray-50 dark:bg-gray-900"
    >
      {VIEWS.map((v, at) => {
        const Icon = v === "list" ? ListBulletIcon : Squares2X2Icon;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={view === v}
            aria-label={VIEW_LABEL[v]}
            tabIndex={view === v ? 0 : -1}
            onClick={() => {
              setView(v);
              setPref("documents-view", v);
            }}
            onKeyDown={(e) => {
              const step = {
                ArrowRight: 1,
                ArrowDown: 1,
                ArrowLeft: -1,
                ArrowUp: -1,
              }[e.key];
              if (!step) return;
              e.preventDefault();
              const next = VIEWS[(at + step + VIEWS.length) % VIEWS.length];
              setView(next);
              setPref("documents-view", next);
              (
                e.currentTarget.parentElement?.children[VIEWS.indexOf(next)] as
                  HTMLElement | undefined
              )?.focus();
            }}
            className={`relative group/tip grid place-items-center size-7 pointer-coarse:size-11 rounded-lg ${
              view === v
                ? "bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 shadow-sm"
                : "text-gray-600 dark:text-gray-400"
            }`}
          >
            <Icon className="size-4" aria-hidden="true" />
            <span aria-hidden="true" className={`${TIP} right-0`}>
              {VIEW_LABEL[v]}
            </span>
          </button>
        );
      })}
    </div>
  );
  const searchBox = (
    <label className="flex shrink-0 items-center gap-2 h-8 w-52 max-w-full px-3 rounded-xl bg-gray-50 dark:bg-gray-900 text-sm">
      <MagnifyingGlassIcon
        className="size-4 shrink-0 text-gray-600 dark:text-gray-400"
        aria-hidden="true"
      />
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search documents"
        aria-label="Search documents"
        className="min-w-0 flex-1 bg-transparent outline-hidden placeholder:text-gray-600 dark:placeholder:text-gray-400"
      />
    </label>
  );
  const actions = listing?.can_upload && (
    <>
      <button
        onClick={(e) => open({ kind: "folder" }, e.currentTarget)}
        className="flex shrink-0 items-center gap-1.5 h-8 px-3 rounded-full whitespace-nowrap text-sm text-gray-900 dark:text-gray-100 hover:bg-black/5 dark:hover:bg-white/5"
      >
        <FolderPlusIcon className="size-4" aria-hidden="true" /> New folder
      </button>
      <button
        onClick={() => picker.current?.click()}
        className="flex shrink-0 items-center gap-1.5 h-8 px-3.5 rounded-full whitespace-nowrap text-sm bg-black text-white hover:bg-gray-900 dark:bg-white dark:text-black"
      >
        <ArrowUpTrayIcon className="size-4" aria-hidden="true" /> Upload
      </button>
    </>
  );
  // an image is its own preview, drawn from the file's own bytes. Every other kind, a PDF included,
  // shows its family's glyph: see evidence/V2/README.md for what a PDF's first page would cost.
  const face = (i: Item, size: string) =>
    i.type === "Image" ? (
      <img
        src={content(i)}
        alt=""
        loading="lazy"
        className={`${size} rounded-md object-cover`}
      />
    ) : (
      <FileIcon family={familyOf(i.type, i.title)} className={size} />
    );
  const itemRow = (i: Item) => (
    <div
      role="row"
      key={i.name}
      className={`${COLS} ${ROW_HEIGHT[density]} px-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5`}
    >
      <span role="cell" className="min-w-0">
        {i.is_folder ? (
          // a folder opens; a file opens its preview
          <button
            onClick={() => openFolder(i.name)}
            className="flex w-full items-center gap-2.5 text-left text-gray-900 dark:text-gray-100"
          >
            <FolderIcon
              className="size-5 shrink-0 text-gray-600 dark:text-gray-400"
              aria-hidden="true"
            />
            <span className="truncate">{i.title}</span>
          </button>
        ) : (
          <button
            onClick={(e) => openPreview(i, e.currentTarget)}
            className="flex w-full items-center gap-2.5 text-left text-gray-900 dark:text-gray-100"
          >
            <FileIcon
              family={familyOf(i.type, i.title)}
              className="size-5 shrink-0"
            />
            <Name title={i.title} />
          </button>
        )}
      </span>
      <span role="cell" className="min-w-0">
        {i.is_folder ? null : <Indexing item={i} onRetry={() => retry(i)} />}
      </span>
      <span
        role="cell"
        className={`${WIDE} truncate text-gray-600 dark:text-gray-400`}
        title={ownerOf(i)}
      >
        {ownerOf(i)}
      </span>
      <span role="cell" className={`${MID} text-gray-600 dark:text-gray-400`}>
        {date(i.modified)}
      </span>
      <span role="cell" className={`${WIDE} text-gray-600 dark:text-gray-400`}>
        {i.is_folder ? plural(i.children ?? 0, "item") : bytes(i.size)}
      </span>
      <span role="cell">
        <RowMenu
          item={i}
          onAsk={() => onAsk(`What does ${i.title} cover?`)}
          onAct={open}
          onPreview={(from) => openPreview(i, from)}
          onRetry={() => retry(i)}
        />
      </span>
    </div>
  );
  // Finder's icon view: no border and no box, a rounded grey wash behind the whole tile while it is
  // hovered or holds focus. Documents has no selection of its own, so focus is what the wash marks.
  const tile = (i: Item) => (
    <li key={i.name} data-tile="" className="group relative">
      <div className="p-2 rounded-2xl group-hover:bg-black/5 dark:group-hover:bg-white/5 group-focus-within:bg-black/5 dark:group-focus-within:bg-white/5">
        <button
          onClick={(e) =>
            i.is_folder ? openFolder(i.name) : openPreview(i, e.currentTarget)
          }
          onKeyDown={onTileKeys}
          className="flex w-full flex-col items-center gap-1.5 text-gray-900 dark:text-gray-100"
        >
          <span className="grid size-12 place-items-center">
            {i.is_folder ? (
              <FolderIcon
                className="size-12 text-gray-600 dark:text-gray-400"
                aria-hidden="true"
              />
            ) : (
              face(i, "size-12")
            )}
          </span>
          <Name title={i.title} className="max-w-full justify-center" />
        </button>
        {!i.is_folder && (
          <div className="mt-1.5 flex justify-center">
            <Indexing item={i} onRetry={() => retry(i)} centred />
          </div>
        )}
      </div>
      <div className="absolute right-1 top-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
        <RowMenu
          item={i}
          onAsk={() => onAsk(`What does ${i.title} cover?`)}
          onAct={open}
          onPreview={(from) => openPreview(i, from)}
          onRetry={() => retry(i)}
        />
      </div>
    </li>
  );
  // Tab still walks every tile, as it walks every row today; the arrows move in two dimensions on
  // top of that. The column count is read off the grid itself, so it follows auto-fill.
  const onTileKeys = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const grid = e.currentTarget.closest("ul");
    if (!grid) return;
    const cols = getComputedStyle(grid).gridTemplateColumns.split(" ").length;
    const step = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: cols,
      ArrowUp: -cols,
    }[e.key];
    if (!step) return;
    const tiles = [...grid.querySelectorAll<HTMLElement>("[data-tile]")];
    const at = tiles.findIndex((t) => t.contains(e.currentTarget));
    const next = at < 0 ? null : tiles[at + step]?.querySelector("button");
    if (!next) return;
    e.preventDefault();
    next.focus();
  };
  const path = listing
    ? searching
      ? [listing.path[0], { name: listing.folder, title: "Search results" }]
      : listing.path
    : [];

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- a drop target for a pointer drag: no role describes one, and the Upload button is the keyboard way to the same thing
    <div
      className="relative flex-1 min-h-0 flex flex-col"
      onDragEnter={(e) =>
        listing?.can_upload &&
        e.dataTransfer.types.includes("Files") &&
        setDragging(true)
      }
    >
      <div
        className={`flex flex-wrap items-center gap-2 px-4 pb-2 ${path.length > 1 ? "" : "@2xl:hidden"}`}
      >
        {/* the trail starts at Documents (Open WebUI, W3C breadcrumb), shown once inside a folder */}
        <nav
          aria-label="Folder"
          className="flex items-center gap-1.5 text-sm min-w-0"
        >
          {(path.length > 1 ? path : []).map((p, i, rest) => (
            <span
              key={`${p.name}-${i}`}
              className="flex items-center gap-1.5 min-w-0"
            >
              {i > 0 && (
                <ChevronRightIcon
                  className="size-3.5 shrink-0 text-gray-600 dark:text-gray-400"
                  aria-hidden="true"
                />
              )}
              {i === rest.length - 1 ? (
                <span
                  aria-current="page"
                  className="text-gray-900 dark:text-gray-100 truncate"
                >
                  {p.title}
                </span>
              ) : (
                <button
                  onClick={() => openFolder(p.name)}
                  className="text-gray-600 dark:text-gray-400 hover:underline truncate"
                >
                  {p.title}
                </button>
              )}
            </span>
          ))}
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-2 @2xl:hidden">
          {searchBox}
          {filter}
          {densityMenu}
          {actions}
          {viewSwitch}
        </div>
      </div>
      {/* one of each pair is display: none, so it is out of the tab order and the accessibility tree */}
      {actionsSlot &&
        createPortal(
          <div className="hidden @2xl:flex items-center gap-2 mr-1">
            {searchBox}
            {filter}
            {densityMenu}
            {actions}
            {viewSwitch}
          </div>,
          actionsSlot,
        )}
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          upload(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />

      <section
        ref={list}
        aria-label="Documents"
        className="flex-1 min-h-0 overflow-y-auto px-4 pb-6 text-sm"
      >
        {failed ? (
          <p className="px-2 py-6 text-gray-600 dark:text-gray-400">
            Documents are unavailable right now.
          </p>
        ) : folders.length + files.length === 0 &&
          uploads.length === 0 &&
          listing ? (
          <div className="px-2 py-10 text-center">
            <FileIcon family="other" className="mx-auto size-10" />
            <p className="mt-3 text-gray-900 dark:text-gray-100">{empty}</p>
            <p className="mt-1 text-gray-600 dark:text-gray-400">
              {narrowed
                ? "Try adjusting your search or filter."
                : listing.can_upload
                  ? "Upload files or drop them here."
                  : "You do not have permission to upload files."}
            </p>
          </div>
        ) : view === "tiles" ? (
          <ul
            aria-label={path.at(-1)?.title}
            className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 py-2"
          >
            {folders.map(tile)}
            {uploads.map((u) => (
              <li key={u.key} className="p-2 text-center">
                <span className="mx-auto grid size-12 place-items-center">
                  <FileIcon
                    family={familyOf(null, u.title)}
                    className="size-12"
                  />
                </span>
                <Name
                  title={u.title}
                  className="mt-1.5 justify-center text-gray-900 dark:text-gray-100"
                />
                <span className="mt-1.5 flex justify-center">
                  <Uploading upload={u} className="text-xs" centred />
                </span>
              </li>
            ))}
            {files.map(tile)}
          </ul>
        ) : (
          <div role="table" aria-label={path.at(-1)?.title}>
            <div
              role="row"
              className={`${COLS} h-8 px-2 text-xs text-gray-600 dark:text-gray-400`}
            >
              {head("title", "Name")}
              <span role="columnheader">Search</span>
              <span role="columnheader" className={WIDE}>
                Owner
              </span>
              {head("modified", "Modified", MID)}
              {head("size", "Size", WIDE)}
              <span role="columnheader" className="sr-only">
                Actions
              </span>
            </div>
            {/* folders, then uploads in progress (Open WebUI puts pending files first), then files */}
            {folders.map(itemRow)}
            {uploads.map((u) => (
              <div
                role="row"
                key={u.key}
                className={`${COLS} ${ROW_HEIGHT[density]} px-2`}
              >
                <span
                  role="cell"
                  className="flex items-center gap-2.5 min-w-0 text-gray-900 dark:text-gray-100"
                >
                  <FileIcon
                    family={familyOf(null, u.title)}
                    className="size-5 shrink-0"
                  />
                  <Name title={u.title} />
                </span>
                <span role="cell" className="min-w-0">
                  <Uploading upload={u} />
                </span>
                <span
                  role="cell"
                  className={`${WIDE} text-gray-600 dark:text-gray-400`}
                >
                  You
                </span>
                <span
                  role="cell"
                  className={`${MID} text-gray-600 dark:text-gray-400`}
                >
                  now
                </span>
                <span
                  role="cell"
                  className={`${WIDE} text-gray-600 dark:text-gray-400`}
                >
                  {bytes(u.size)}
                </span>
                <span role="cell" />
              </div>
            ))}
            {files.map(itemRow)}
          </div>
        )}
      </section>

      {dragging && (
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- the same drop target, while the drag is over it
        <div
          className="absolute inset-0 z-40 m-2 grid place-items-center rounded-2xl backdrop-blur-sm bg-gray-100/60 dark:bg-gray-900/80 border-2 border-dashed border-gray-600 dark:border-gray-400"
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            upload(Array.from(e.dataTransfer.files));
          }}
        >
          <div className="text-center pointer-events-none">
            <p className="text-lg text-gray-900 dark:text-gray-100">
              Add to Documents
            </p>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              They go into Drive, in this folder, and become searchable
            </p>
          </div>
        </div>
      )}

      <Preview
        item={preview}
        onClose={() => setPreview(null)}
        onCloseAutoFocus={backToOpener}
      />
      <Modal
        open={ask?.kind === "folder" || ask?.kind === "rename"}
        onOpenChange={(o) => !o && setAsk(null)}
        onCloseAutoFocus={backToOpener}
        title={ask?.kind === "rename" ? "Rename" : "New folder"}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const next = name.trim();
            if (!next || !listing) return;
            act(() =>
              ask?.kind === "rename"
                ? post(DRIVE.rename, {
                    entity_name: ask.item.name,
                    new_title: next,
                  })
                : post(DRIVE.createFolder, {
                    team: listing.team,
                    file_name: next,
                    parent: listing.folder,
                  }),
            );
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Name"
            className="mt-1 w-full rounded-xl px-4 py-2 text-sm bg-gray-50 dark:bg-gray-900 dark:text-gray-200 outline-hidden"
          />
          {error && (
            <p
              role="alert"
              className="mt-2 text-sm text-red-600 dark:text-red-400"
            >
              {error}
            </p>
          )}
          <div className="mt-5 flex justify-between gap-1.5">
            {cancel}
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className={CONFIRM}
            >
              {ask?.kind === "rename" ? "Save" : "Create"}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={ask?.kind === "move"}
        onOpenChange={(o) => !o && setAsk(null)}
        onCloseAutoFocus={backToOpener}
        title={ask?.kind === "move" ? `Move ${ask.item.title}` : "Move"}
      >
        {ask?.kind === "move" && (
          <MoveTo
            item={ask.item}
            onCancel={() => setAsk(null)}
            onMove={(target) =>
              act(() =>
                post(DRIVE.move, {
                  entity_names: [ask.item.name],
                  new_parent: target,
                }),
              )
            }
          />
        )}
        {error && (
          <p
            role="alert"
            className="mt-2 text-sm text-red-600 dark:text-red-400"
          >
            {error}
          </p>
        )}
      </Modal>

      <Modal
        open={ask?.kind === "trash"}
        onOpenChange={(o) => !o && setAsk(null)}
        onCloseAutoFocus={backToOpener}
        title="Move to Trash?"
        description={
          ask?.kind === "trash"
            ? `${ask.item.title} goes to Drive's Trash. Answers stop using it now, and you can restore it from Drive.`
            : undefined
        }
      >
        {error && (
          <p
            role="alert"
            className="mt-2 text-sm text-red-600 dark:text-red-400"
          >
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-between gap-1.5">
          {cancel}
          <button
            disabled={busy}
            onClick={() =>
              ask?.kind === "trash" &&
              act(() =>
                post(DRIVE.trash, {
                  entity_names: [ask.item.name],
                }),
              )
            }
            className={CONFIRM}
          >
            Move to Trash
          </button>
        </div>
      </Modal>
    </div>
  );
}
