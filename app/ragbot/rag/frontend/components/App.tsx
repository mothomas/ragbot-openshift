"use client";
import { PencilSquareIcon } from "@heroicons/react/24/outline";
import dynamic from "next/dynamic";
import { Dialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { useAnnouncement } from "@/lib/announce";
import { useDocuments } from "@/lib/data";
import { useHandover } from "@/lib/focus";
import { boot, list } from "@/lib/frappe";
import { modelTip } from "@/lib/format";
import { FRAPPE_AI } from "@/lib/peers";
import { apply } from "@/lib/theme";
import Sidebar from "./Sidebar";
import { MAIN, SHELL } from "./FirstView";
import Chat from "./Chat";
import { ConnectionToasts, PanelIcon, StatusChip, useLink } from "./Connection";
import StatusPanel from "./StatusPanel";
import SignIn from "./SignIn";

// /ask opens on the chat, so the document browser's code is fetched when the reader asks for it
const Documents = dynamic(() => import("./Documents"), { ssr: false });

export type View = {
  chat: string | null;
  view: "chat" | "documents";
  folder: string | null;
};

function readView(): View {
  const p = new URLSearchParams(location.search);
  return {
    chat: p.get("c"),
    view: p.get("view") === "documents" ? "documents" : "chat",
    folder: p.get("f"),
  };
}

function go(next: Partial<View>, current: View): View {
  const v = { ...current, ...next };
  const p = new URLSearchParams();
  if (v.view === "documents") p.set("view", "documents");
  if (v.chat && v.view === "chat") p.set("c", v.chat);
  if (v.folder && v.view === "documents") p.set("f", v.folder);
  history.pushState(null, "", `/ask${p.size ? `?${p}` : ""}`);
  return v;
}

export default function App() {
  useEffect(() => {
    apply();
    // "system" follows the Mac's light and dark switch while the page is open
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const follow = () => apply();
    scheme.addEventListener("change", follow);
    return () => scheme.removeEventListener("change", follow);
  }, []);
  // a tooltip must be dismissible without moving the pointer or the focus off its anchor, and must
  // come back after: Escape hides the open one, the next pointer move or focus arms them again
  useEffect(() => {
    const root = document.documentElement;
    const hide = (e: KeyboardEvent) => {
      if (e.key === "Escape") root.dataset.tip = "off";
    };
    const show = () => {
      if (root.dataset.tip) delete root.dataset.tip;
    };
    addEventListener("keydown", hide);
    addEventListener("pointermove", show, { passive: true });
    addEventListener("focusin", show);
    return () => {
      removeEventListener("keydown", hide);
      removeEventListener("pointermove", show);
      removeEventListener("focusin", show);
    };
  }, []);
  // boot is fixed for the page's life, so this branch never changes between renders
  return boot().user === "Guest" ? <SignIn /> : <Workspace />;
}

function Workspace() {
  const [view, setView] = useState<View>(readView);
  const [menu, setMenu] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      // Open WebUI starts with the rail until the viewer opens the sidebar once
      return localStorage.getItem("sidebar") !== "open";
    } catch {
      return true;
    }
  });
  const [draft, setDraft] = useState(() => crypto.randomUUID()); // the id a new chat will take
  const [initial, setInitial] = useState<string>();
  const [tick, setTick] = useState(0);
  // the demo's Status panel, which a site turns off in its own config (rag_status_panel)
  const panel = boot().status_panel;
  const [status, setStatus] = useState(false);
  const [named, setNamed] = useState<{
    chat: string | null;
    tick: number;
    title: string;
  }>({ chat: null, tick: 0, title: "" });
  const [docsChanged, setDocsChanged] = useState(0);
  const { docs, failed: docsFailed } = useDocuments(docsChanged);
  const [titleFailed, setTitleFailed] = useState(false);
  const link = useLink();
  const said = useAnnouncement();
  // A live region announces a change, so the same words twice have to arrive as one: empty it, then
  // fill it a beat later, as Angular's CDK LiveAnnouncer does for the browser and screen reader
  // pairs that otherwise read a repeated message once. React owns no children of that node.
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = region.current;
    if (!el || !said.text) return;
    el.textContent = "";
    const fill = setTimeout(() => {
      el.textContent = said.text;
    }, 100);
    return () => clearTimeout(fill);
  }, [said]);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  // the toggle unmounts while the panel is open, so it takes the focus back when the panel closes
  const statusToggle = useRef<HTMLButtonElement>(null);
  useHandover(status, statusToggle);
  const collapse = (c: boolean) => {
    setCollapsed(c);
    try {
      localStorage.setItem("sidebar", c ? "collapsed" : "open");
    } catch {
      // private windows: the choice lasts this page only
    }
  };
  // past Tailwind's md the sidebar is part of the layout again, and a dialog portalled to <body>
  // is not: a window widened while the drawer is open closes it
  useEffect(() => {
    const wide = matchMedia("(min-width: 48rem)");
    const close = () => wide.matches && setMenu(false);
    wide.addEventListener("change", close);
    return () => wide.removeEventListener("change", close);
  }, []);
  useEffect(() => {
    const onPop = () => setView(readView());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  // the agent names a chat after its first question, so read the name again once an answer lands
  useEffect(() => {
    if (view.chat)
      list<{ title: string }>(FRAPPE_AI.session, {
        fields: ["title"],
        filters: [["name", "=", view.chat]],
        limit: 1,
      })
        .then((r) => {
          setNamed({ chat: view.chat, tick, title: r[0]?.title ?? "" });
          setTitleFailed(false);
        })
        .catch(() => setTitleFailed(true));
  }, [view.chat, tick]);
  // the name read for this chat and this answer; until that read lands there is no name to show
  const title =
    named.chat === view.chat && named.tick === tick ? named.title : "";
  const nav = (n: Partial<View>) => setView((v) => go(n, v));
  const chatId = view.chat ?? draft;
  const newChat = (question?: string) => {
    setDraft(crypto.randomUUID());
    setInitial(question);
    nav({ view: "chat", chat: null });
  };
  const onGo = (n: Partial<View>) =>
    n.view === "chat" && n.chat === null ? newChat() : nav(n);
  // only indexed documents: a question about one the search cannot see would find nothing
  const suggestions = (docs ?? [])
    .filter((d) => d.indexed)
    .slice(0, 3)
    .map((d) => ({
      title: d.file_name,
      hint: "What does it cover?",
      prompt: `What does ${d.file_name} cover?`,
    }));

  return (
    // the phone's sidebar drawer: the trigger is in the header below, the dialog itself in <Sidebar>
    <Dialog.Root open={menu} onOpenChange={setMenu}>
      <div className={SHELL}>
        <Sidebar
          view={view}
          tick={tick}
          mobileOpen={menu}
          collapsed={collapsed}
          onCollapse={collapse}
          onClose={() => setMenu(false)}
          onGo={onGo}
        />
        <main className={MAIN}>
          {/* measured from Open WebUI's navbar: a 15px title, 24px icon buttons, 8px from the edge */}
          <header className="flex items-center gap-1 h-12 px-2">
            <Dialog.Trigger
              aria-label="Open sidebar"
              className="md:hidden p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5"
            >
              <PanelIcon action="open" className="size-5" />
            </Dialog.Trigger>
            {view.view === "documents" ? (
              <h1 className="px-1.5 text-sm text-gray-900 dark:text-white">
                {view.folder ? (
                  <button
                    onClick={() => nav({ folder: null })}
                    className="hover:underline"
                  >
                    Documents
                  </button>
                ) : (
                  "Documents"
                )}{" "}
                <span className="text-gray-600 dark:text-gray-400">
                  {docs?.length ?? ""}
                </span>
              </h1>
            ) : (
              title && (
                <h1 className="min-w-0 truncate px-1 py-1 text-[0.9375rem] text-gray-700 dark:text-gray-200">
                  {title}
                </h1>
              )
            )}
            {/* a name or a count that could not be read: the same line for both, next to where they would be */}
            {(titleFailed || docsFailed) && (
              <p
                role="alert"
                className="px-1.5 text-sm text-red-600 dark:text-red-400"
              >
                Connection failed
              </p>
            )}
            <div className="ml-auto flex items-center gap-1">
              <div ref={setActions} className="empty:hidden" />
              <button
                aria-label="New chat"
                onClick={() => newChat()}
                className="md:hidden flex size-6 items-center justify-center rounded-lg text-gray-600 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/5"
              >
                <PencilSquareIcon className="size-5" />
              </button>
              <StatusChip link={link} />
              {/* like the left sidebar: the toggle sits here while the panel is closed, inside it while open */}
              {panel && !status && (
                <button
                  ref={statusToggle}
                  aria-label="Open status panel"
                  aria-expanded={false}
                  onClick={() => setStatus(true)}
                  className="grid place-items-center size-8 rounded-xl text-gray-700 dark:text-gray-300 hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <PanelIcon side="right" action="open" />
                </button>
              )}
            </div>
          </header>
          {view.view === "documents" ? (
            <Documents
              actionsSlot={actions}
              folder={view.folder ?? ""}
              onOpen={(f) => nav({ folder: f || null })}
              onAsk={newChat}
              onChanged={() => setDocsChanged((n) => n + 1)}
            />
          ) : (
            <Chat
              key={chatId}
              sessionId={chatId}
              model={link?.model ?? null}
              modelTip={modelTip(link?.runs)}
              suggestions={suggestions}
              initial={initial}
              onStarted={() => {
                setInitial(undefined);
                if (!view.chat) nav({ chat: chatId });
              }}
              onDone={() => setTick((t) => t + 1)}
            />
          )}
        </main>
        {panel && status && (
          <StatusPanel
            link={link}
            refresh={tick}
            onClose={() => setStatus(false)}
          />
        )}
        {/* what the page shows only in passing: a file indexed, an upload failed, a search found
            nothing, an answer copied. aria-live as well as role=status, and aria-atomic with it
            (WCAG technique ARIA22): the attribute is also what aria-hidden's hideOthers spares
            when a dialog hides the rest of the page. */}
        <div
          ref={region}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        />
        <ConnectionToasts link={link} />
      </div>
    </Dialog.Root>
  );
}
