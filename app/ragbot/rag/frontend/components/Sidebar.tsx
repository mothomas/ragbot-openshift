"use client";
import {
  ArrowRightStartOnRectangleIcon,
  DocumentTextIcon,
  EllipsisHorizontalIcon,
  PencilSquareIcon,
  SunIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { Dialog, DropdownMenu } from "radix-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { boot, list, post } from "@/lib/frappe";
import { handBack, useHandover } from "@/lib/focus";
import { ago, fromServer, relativeDay } from "@/lib/format";
import { FRAPPE_AI } from "@/lib/peers";
import { getMode, setMode, type Mode } from "@/lib/theme";
import type { View } from "./App";
import { PanelIcon } from "./Connection";
import { AppMark } from "./Mark";
import {
  CANCEL,
  CONFIRM,
  MENU as menu,
  MENU_ITEM as menuItem,
  Modal,
} from "./parts";

type Session = { name: string; title: string; last_activity: string };
type Props = {
  view: View;
  tick: number;
  mobileOpen: boolean;
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
  onClose: () => void;
  onGo: (n: Partial<View>) => void;
};

const when = (s: Session) => fromServer(s.last_activity, boot().time_zone);
const PAGE = 100;

// The bar before a group heading. relativeDay() runs on into month and year names, so anything
// older than a week shares the neutral grey rather than inventing a colour per month.
const GROUP_BAR: Record<string, string> = {
  Today: "bg-group-today",
  Yesterday: "bg-group-1d",
  "Previous 7 days": "bg-group-7d",
};

// A chat in the list: opening it, and a menu (hover or focus shows it; always on touch) to delete it
function ChatRow({
  s,
  current,
  onOpen,
  onDeleted,
}: {
  s: Session;
  current: boolean;
  onOpen: () => void;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const title = s.title || "New chat";
  const remove = () =>
    post("rag.chat.delete_chat", { session: s.name })
      .then(() => {
        setConfirming(false);
        onDeleted();
      })
      .catch(() => setFailed(true));
  return (
    <div
      className={`group relative rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition ${current ? "bg-black/[0.035] dark:bg-white/[0.045]" : ""}`}
    >
      <button
        onClick={onOpen}
        aria-current={current ? "page" : undefined}
        className="flex items-center justify-between gap-2 w-full h-8 pl-[11px] pr-2.5 text-left text-[13px] leading-5"
      >
        <span className="min-w-0 truncate">{title}</span>
        <span className="shrink-0 text-[11px] leading-5 text-gray-600 dark:text-gray-400 group-hover:invisible group-focus-within:invisible group-has-[[data-state=open]]:invisible [@media(hover:none)]:invisible">
          {ago(when(s))}
        </span>
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          ref={more}
          aria-label={`More options for ${title}`}
          className="absolute right-1.5 top-1.5 grid place-items-center size-5 rounded-md text-gray-600 dark:text-gray-400 hover:text-black dark:hover:text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <EllipsisHorizontalIcon className="size-4" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" className={menu}>
            <DropdownMenu.Item
              onSelect={() => {
                setFailed(false);
                setConfirming(true);
              }}
              className={`${menuItem} flex items-center gap-2`}
            >
              <TrashIcon className="size-4" strokeWidth={1.5} /> Delete
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {/* the menu item that opened it is gone, so focus goes back to the menu's button */}
      <Modal
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete chat?"
        description={`This will delete ${title}.`}
        onCloseAutoFocus={(e) => handBack(e, more)}
      >
        {failed && (
          <p
            role="alert"
            className="mt-2 text-sm text-red-600 dark:text-red-400"
          >
            Couldn&apos;t delete this chat. Try again.
          </p>
        )}
        <div className="mt-5 flex justify-between gap-1.5">
          <button onClick={() => setConfirming(false)} className={CANCEL}>
            Cancel
          </button>
          <button onClick={remove} className={CONFIRM}>
            Delete
          </button>
        </div>
      </Modal>
    </div>
  );
}

function UserMenu({ compact }: { compact: boolean }) {
  const [mode, setModeState] = useState<Mode>(getMode);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        // not compact, the button shows the reader's own name, so the name it answers to has to
        // start with it: WCAG 2.2 2.5.3 Label in Name
        aria-label={
          compact
            ? "Account and theme"
            : `${boot().full_name}, account and theme`
        }
        className={`${compact ? "p-1" : "m-2 px-2 py-1.5 w-[calc(100%-1rem)]"} flex items-center gap-2.5 rounded-xl text-[13px] leading-5 hover:bg-black/5 dark:hover:bg-white/5`}
      >
        <span className="size-6 shrink-0 rounded-full bg-gray-200 dark:bg-gray-800 grid place-items-center text-xs text-gray-700 dark:text-gray-200">
          {boot().full_name.slice(0, 1)}
        </span>
        {!compact && (
          <span className="min-w-0 text-left">{boot().full_name}</span>
        )}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side="top" align="start" className={menu}>
          <DropdownMenu.Label className="px-3 py-1.5 text-xs text-gray-600 dark:text-gray-400 flex items-center gap-2">
            <SunIcon className="size-4" strokeWidth={1.5} /> Theme
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={mode}
            onValueChange={(m) => {
              setMode(m as Mode);
              setModeState(m as Mode);
            }}
          >
            {(["system", "light", "dark"] as const).map((m) => (
              <DropdownMenu.RadioItem
                key={m}
                value={m}
                className={`${menuItem} capitalize data-[state=checked]:font-medium`}
              >
                {m}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="my-1 h-px bg-gray-100 dark:bg-gray-800" />
          <DropdownMenu.Item
            onSelect={() =>
              post("logout").finally(() => location.assign("/ask"))
            }
            className={`${menuItem} flex items-center gap-2`}
          >
            <ArrowRightStartOnRectangleIcon
              className="size-4"
              strokeWidth={1.5}
            />{" "}
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export default function Sidebar({
  view,
  tick,
  mobileOpen,
  collapsed,
  onCollapse,
  onClose,
  onGo,
}: Props) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(true);
  // a state, not a ref: the collapsed sidebar does not render it, so the observer must follow it in and out
  const [end, setEnd] = useState<HTMLDivElement | null>(null);
  const loading = useRef(false);
  // collapsing and expanding swap one toggle for the other, so the survivor takes the focus
  const toggle = useRef<HTMLButtonElement>(null);
  useHandover(collapsed, toggle);
  // closed by a window widened past md, the trigger Radix hands the focus back to is display:none
  useHandover(mobileOpen, toggle);

  const page = useCallback((start: number) => {
    if (loading.current) return;
    loading.current = true;
    list<Session>(FRAPPE_AI.session, {
      fields: ["name", "title", "last_activity"],
      order_by: "last_activity desc",
      limit: PAGE,
      start,
    })
      .then((rows) => {
        // a chat made meanwhile shifts the window, so a page can repeat a row this list already holds
        setSessions((all) => {
          const by = new Map((start ? all : []).map((s) => [s.name, s]));
          for (const r of rows) by.set(r.name, r);
          return [...by.values()];
        });
        setMore(rows.length === PAGE);
        setFailed(false);
      })
      // no chats and chats that could not be read are not the same thing
      .catch(() => setFailed(true))
      .finally(() => {
        loading.current = false;
      });
  }, []);

  // `tick` moves when an answer finishes: the agent creates the session row during the turn
  useEffect(() => {
    page(0);
  }, [view.chat, tick, page]);

  // the next page loads as the end of the list comes into view, so no chat is out of reach
  useEffect(() => {
    if (!end || !more) return;
    const io = new IntersectionObserver(
      ([e]) => e.isIntersecting && page(sessions.length),
    );
    io.observe(end);
    return () => io.disconnect();
  }, [end, more, sessions.length, page]);
  const go = (n: Partial<View>) => {
    onGo(n);
    onClose();
  };

  const groups = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = relativeDay(when(s));
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const row =
    "flex items-center gap-2 w-full h-8 rounded-xl text-[13px] leading-5 hover:bg-black/5 dark:hover:bg-white/5 transition";
  const iconButton =
    "grid place-items-center size-8 rounded-xl hover:bg-black/5 dark:hover:bg-white/5";

  if (collapsed && !mobileOpen) {
    return (
      <nav
        aria-label="Chat history"
        className="hidden md:flex w-(--rail-width) shrink-0 flex-col items-center py-2 gap-1 text-gray-700 dark:text-gray-300"
      >
        <button
          ref={toggle}
          aria-label="Open sidebar"
          onClick={() => onCollapse(false)}
          className={iconButton}
        >
          <AppMark className="size-5" />
        </button>
        <button
          aria-label="New chat"
          onClick={() => go({ view: "chat", chat: null })}
          className={iconButton}
        >
          <PencilSquareIcon className="size-4" strokeWidth={1.5} />
        </button>
        <button
          aria-label="Documents"
          onClick={() => go({ view: "documents", folder: null })}
          className={iconButton}
        >
          <DocumentTextIcon className="size-4" strokeWidth={1.5} />
        </button>
        <div className="flex-1" />
        <UserMenu compact />
      </nav>
    );
  }

  const nav = (
    <nav
      aria-label="Chat history"
      className={`${mobileOpen ? "fixed inset-y-0 left-0 z-50 flex" : "hidden md:flex"} w-(--sidebar-width) shrink-0 flex-col bg-gray-50 dark:bg-gray-950 text-gray-700 dark:text-gray-300 select-none`}
    >
      <div className="flex items-center gap-2 pl-3 pr-2 h-12">
        <AppMark className="size-5" />
        <span className="flex-1 text-[13px] leading-5 font-bold dark:text-gray-200">
          Metis
        </span>
        <button
          ref={toggle}
          aria-label="Close sidebar"
          onClick={() => (mobileOpen ? onClose() : onCollapse(true))}
          className={iconButton}
        >
          <PanelIcon action="close" />
        </button>
      </div>
      <div className="px-2 flex flex-col">
        <button
          className={`${row} px-2`}
          onClick={() => go({ view: "chat", chat: null })}
        >
          <PencilSquareIcon className="size-4" strokeWidth={1.5} /> New chat
        </button>
        <button
          className={`${row} px-2 aria-[current=page]:bg-black/[0.035] dark:aria-[current=page]:bg-white/[0.045]`}
          aria-current={view.view === "documents" ? "page" : undefined}
          onClick={() => go({ view: "documents", folder: null })}
        >
          <DocumentTextIcon className="size-4" strokeWidth={1.5} /> Documents
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 mt-4">
        {failed && (
          <p
            role="alert"
            className="px-2.5 text-sm text-red-600 dark:text-red-400"
          >
            Connection failed
          </p>
        )}
        {[...groups].map(([label, rows], i) => (
          <section key={label} className={i ? "mt-[18px]" : undefined}>
            {/* the sidebar's own surface, not white: a row scrolling under must not show through */}
            <h2 className="sticky top-0 z-10 flex items-center gap-2 pr-2.5 py-1 bg-gray-50 dark:bg-gray-950 text-[11px] leading-4 font-semibold tracking-[0.5px] uppercase text-gray-600 dark:text-gray-500">
              <span
                aria-hidden="true"
                className={`h-3 w-[3px] rounded-full ${GROUP_BAR[label] ?? "bg-gray-300 dark:bg-gray-600"}`}
              />
              {label}
            </h2>
            {rows.map((s) => {
              const current = view.view === "chat" && view.chat === s.name;
              return (
                <ChatRow
                  key={s.name}
                  s={s}
                  current={current}
                  onOpen={() => go({ view: "chat", chat: s.name })}
                  onDeleted={() => {
                    setSessions((all) => all.filter((x) => x.name !== s.name));
                    if (current) go({ view: "chat", chat: null });
                  }}
                />
              );
            })}
          </section>
        ))}
        <div ref={setEnd} className="h-px" />
      </div>
      <UserMenu compact={false} />
    </nav>
  );
  // On a phone the sidebar is a drawer over the chat, which is a modal dialog: Radix moves the focus
  // in, keeps it there, closes on Escape, hides the rest of the page from the accessibility tree and
  // gives the focus back to the button in App's header. <Dialog.Root> is that button's, in App.
  return mobileOpen ? (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-black/45" />
      <Dialog.Content asChild>{nav}</Dialog.Content>
    </Dialog.Portal>
  ) : (
    nav
  );
}
