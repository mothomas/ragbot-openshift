"use client";
import {
  CheckCircleIcon,
  CloudIcon,
  ExclamationTriangleIcon,
  ServerStackIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { Toast } from "radix-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { log, type Kind } from "@/lib/activity";
import {
  chipReading,
  chipTip,
  seconds,
  type Checks,
  type Runs,
} from "@/lib/format";
import { get } from "@/lib/frappe";
import { usePoll } from "@/lib/poll";
import { TIP } from "./parts";

// The link to the agent: the poll behind the top bar's chip and the composer's model name, the two
// connection toasts, and the panel toggle's icon. This stays when the Status panel is switched off.

type Line = [Kind, string];

// A panel with its side column marked, and a chevron pointing the way the panel will move,
// the pattern of Lucide's panel-*-open/close, Material's *_panel_open/close and Octicons' sidebar-*
export function PanelIcon({
  side = "left",
  action,
  className = "size-4",
}: {
  side?: "left" | "right";
  action: "open" | "close";
  className?: string;
}) {
  const edge = side === "left" ? 9.25 : 14.75;
  const mid = side === "left" ? 14.75 : 9.25;
  const pointsLeft = (side === "left") === (action === "close");
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3.75" y="4.5" width="16.5" height="15" rx="3" />
      <path d={`M${edge} 4.5v15`} />
      <path
        d={
          pointsLeft
            ? `M${mid + 1.25} 9.5 ${mid - 1.25} 12l2.5 2.5`
            : `M${mid - 1.25} 9.5 ${mid + 1.25} 12l-2.5 2.5`
        }
      />
    </svg>
  );
}

export type Link = {
  location: string;
  rtt_ms: number | null;
  ok: boolean;
  model: string | null;
  runs: Runs | null;
  checks: Checks;
};

export type MarkSource = string | typeof CloudIcon;

// Where it runs: a Simple Icons 12.0.0 mark (CC0, one colour), or a plain icon where there is no brand
export const PLACES: Record<string, { name: string; mark: MarkSource }> = {
  onprem: { name: "On-premises", mark: ServerStackIcon },
  cloud: { name: "Cloud", mark: CloudIcon },
  ec2: { name: "Amazon EC2", mark: "amazonec2" },
  eks: { name: "Amazon EKS", mark: "amazoneks" },
  rosa: { name: "ROSA", mark: "redhatopenshift" },
  openshift: { name: "Red Hat OpenShift", mark: "redhatopenshift" },
  digitalocean: { name: "DigitalOcean", mark: "digitalocean" },
  gcp: { name: "Google Cloud", mark: "googlecloud" },
  azure: { name: "Azure", mark: "microsoftazure" },
};

export type Reading = { location: string; checks: Checks };
export type Watch = {
  prev: Reading | null;
  lostAt: number | null;
  ever: boolean;
  warned: boolean;
};
export const WATCH: Watch = {
  prev: null,
  lostAt: null,
  ever: false,
  warned: false,
};
// Open WebUI waits 2 s before its "Connection lost" toast, and says "Reconnected" only after it
const WARN_AFTER_MS = 2_000;
const CHECKS = [
  ["model", "Model"],
  ["tools", "MCP server"],
] as const;

// One poll of the link against the last: the lines it adds to Activity, and which toast to show
export function step(
  w: Watch,
  r: Reading,
  now: number,
  place: (key: string) => string,
): { watch: Watch; lines: Line[]; toast: "lost" | "back" | null } {
  const lines: Line[] = [];
  let { lostAt, ever, warned } = w;
  let toast: "lost" | "back" | null = null;
  const was = w.prev?.checks.agent === true;
  const is = r.checks.agent === true;
  const from = w.prev?.location;
  if (from && r.location && from !== r.location)
    lines.push([
      "move",
      `Provider changed from ${place(from)} to ${place(r.location)}`,
    ]);
  if (is && !was) {
    lines.push([
      "ok",
      ever && lostAt !== null
        ? `Reconnected after ${seconds(Math.max(1, (now - lostAt) / 1000))}`
        : "Connected",
    ]);
    if (warned) toast = "back";
    [ever, lostAt, warned] = [true, null, false];
  } else if (was && !is) {
    lines.push(["bad", "Connection lost"]);
    lostAt = now;
  } else if (was && is) {
    for (const [key, label] of CHECKS) {
      const [a, b] = [w.prev!.checks[key], r.checks[key]];
      if (a === true && b === false) lines.push(["bad", `${label} down`]);
      if (a === false && b === true) lines.push(["ok", `${label} up`]);
    }
  }
  if (!is && lostAt !== null && !warned && now - lostAt >= WARN_AFTER_MS)
    [toast, warned] = ["lost", true];
  return { watch: { prev: r, lostAt, ever, warned }, lines, toast };
}

// one poll for the top-bar chip and the composer's model name
export function useLink() {
  const [link, setLink] = useState<Link | null>(null);
  const poll = useCallback(
    () =>
      get<Link>("rag.status.link")
        .then(setLink)
        .catch(() =>
          setLink((l) => ({
            location: l?.location ?? "",
            rtt_ms: null,
            ok: false,
            model: l?.model ?? null,
            runs: l?.runs ?? null,
            checks: { agent: null, tools: null, model: null },
          })),
        ),
    [],
  );
  // now, so the chip reads from the poll that starts as the page mounts rather than the next one
  usePoll(poll, 1_000, { now: true });
  return link;
}

// Turns each poll into Activity lines, and shows Open WebUI's two connection toasts at the top right
export function ConnectionToasts({ link }: { link: Link | null }) {
  const watch = useRef(WATCH);
  const [toast, setToast] = useState<{ id: number; lost: boolean } | null>(
    null,
  );
  useEffect(() => {
    if (!link) return;
    const now = Date.now();
    const r = step(watch.current, link, now, (k) => PLACES[k]?.name ?? k);
    watch.current = r.watch;
    r.lines.forEach(([kind, text]) => log(kind, text, now));
    if (r.toast) setToast({ id: now, lost: r.toast === "lost" });
  }, [link]);
  const tone = toast?.lost
    ? "bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-950 dark:border-amber-900 dark:text-amber-200"
    : "bg-green-50 border-green-200 text-green-800 dark:bg-green-950 dark:border-green-900 dark:text-green-200";
  const Icon = toast?.lost ? ExclamationTriangleIcon : CheckCircleIcon;
  return (
    <Toast.Provider duration={4_000}>
      {toast && (
        <Toast.Root
          key={toast.id}
          type="background"
          onOpenChange={(open) => !open && setToast(null)}
          className={`flex items-center gap-2 w-[300px] max-w-[calc(100vw-1.5rem)] rounded-lg border px-4 py-3 text-[13px] shadow-sm ${tone}`}
        >
          <Icon className="size-4 shrink-0" aria-hidden="true" />
          <Toast.Title className="flex-1">
            {toast.lost ? "Connection lost. Reconnecting…" : "Reconnected"}
          </Toast.Title>
          <Toast.Close
            aria-label="Close"
            className="grid place-items-center size-5 rounded-md opacity-60 hover:opacity-100"
          >
            <XMarkIcon className="size-4" />
          </Toast.Close>
        </Toast.Root>
      )}
      <Toast.Viewport className="fixed top-14 right-3 z-50 flex flex-col gap-2 outline-hidden" />
    </Toast.Provider>
  );
}

// The top-bar status: the round trip to the agent while the agent, its MCP server and its model
// all answer. Where it runs is in the panel; the hover says what the number is, or what failed.
export function StatusChip({ link }: { link: Link | null }) {
  if (!link) return null;
  const reading = chipReading(
    link.ok,
    link.rtt_ms,
    link.checks.agent,
    navigator.onLine,
  );
  const tip = chipTip(link.ok, link.checks, navigator.onLine);
  return (
    <span className="relative group/tip flex shrink-0 items-center gap-1.5 h-8 px-3 rounded-full whitespace-nowrap border border-gray-50 dark:border-gray-850/30 text-xs text-gray-700 dark:text-gray-300">
      <span
        className={`size-1.5 rounded-full ${link.ok ? "bg-green-500" : "bg-red-500"}`}
        aria-hidden="true"
      />
      <span className="sr-only">{tip}: </span>
      <span
        className={`tabular-nums ${link.ok ? "text-gray-600 dark:text-gray-400" : "text-red-600 dark:text-red-400"}`}
      >
        {reading}
      </span>
      <span aria-hidden="true" className={`${TIP} right-0`}>
        {tip}
      </span>
    </span>
  );
}
