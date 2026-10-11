"use client";
import {
  ArrowsRightLeftIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  DocumentTextIcon,
  ExclamationTriangleIcon,
  MinusCircleIcon,
  XCircleIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { useActivity, type Kind } from "@/lib/activity";
import { get } from "@/lib/frappe";
import {
  eventTime,
  healthChecks,
  healthLine,
  median,
  paceBand,
  READ_TPS,
  runsLabel,
  SLOW_TPS,
  uptime,
} from "@/lib/format";
import { ASSETS } from "@/lib/peers";
import { PanelIcon, PLACES, type Link, type MarkSource } from "./Connection";

type Speed = { id: string; tps: number | null; ttft: number | null };
type Summary = {
  model: {
    provider: string | null;
    host: string | null;
    endpoint: string | null;
    resolved: string | null;
  } | null;
  // null where frappe_ai is absent: the chats the timings come from are its own
  speeds: Speed[] | null;
  platform: { runtime: "docker" | "kubernetes" | null };
  index: { chunks: number; ok: boolean };
  // what the server can prove about where it runs; pod fields only on Kubernetes
  runtime: {
    region: string | null;
    zone: string | null;
    host?: string;
    node?: string | null;
    namespace?: string | null;
    pod?: string;
    ip: string | null;
    uptime_s: number | null;
  };
};

// Each owner's wording, shown only for the names on screen
const NOTICE: Record<string, string> = {
  docker: "Docker is a trademark of Docker, Inc.",
  kubernetes: "Kubernetes® is a registered trademark of The Linux Foundation.",
  ec2: "Amazon EC2 is a trademark of Amazon.com, Inc. or its affiliates.",
  eks: "Amazon EKS is a trademark of Amazon.com, Inc. or its affiliates.",
  rosa: "Red Hat and OpenShift are trademarks of Red Hat, LLC.",
  openshift: "Red Hat and OpenShift are trademarks of Red Hat, LLC.",
  digitalocean: "DigitalOcean is a trademark of DigitalOcean, LLC.",
  gcp: "Google Cloud is a trademark of Google LLC.",
  azure: "Microsoft Azure is a trademark of the Microsoft group of companies.",
};

// `chip` and `ink` are whole class names because Tailwind reads the source, not the values
const PLATFORMS = {
  docker: {
    name: "Docker",
    mark: "docker",
    chip: "bg-brand-docker/12",
    ink: "bg-brand-docker",
  },
  kubernetes: {
    name: "Kubernetes",
    mark: "kubernetes",
    chip: "bg-brand-kubernetes/12",
    ink: "bg-brand-kubernetes",
  },
};

function BrandMark({
  mark,
  className = "size-3.5",
  ink = "bg-current",
}: {
  mark: MarkSource;
  className?: string;
  ink?: string;
}) {
  if (typeof mark !== "string") {
    const Icon = mark;
    return <Icon className={`${className} shrink-0`} aria-hidden="true" />;
  }
  // a mask paints the one-colour mark in `ink`, which is the text colour unless a caller names a brand
  const url = `url(${ASSETS}/marks/${mark}.svg)`;
  return (
    <span
      aria-hidden="true"
      className={`${className} shrink-0 ${ink}`}
      style={{
        mask: `${url} center / contain no-repeat`,
        WebkitMask: `${url} center / contain no-repeat`,
      }}
    />
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-3.5 py-2.5">
      <dt className="shrink-0 text-xs leading-5 text-gray-600 dark:text-gray-400">
        {label}
      </dt>
      {/* a long node name wraps rather than being cut, at its dots first (see breakable) */}
      <dd className="flex items-center justify-end gap-1.5 min-w-0 text-right wrap-break-word text-gray-900 dark:text-gray-100">
        {children}
      </dd>
    </div>
  );
}

// lets a host name or address wrap after a dot or colon instead of inside a word or number
const breakable = (v: string) =>
  v
    .split(/(?<=[.:])/)
    .flatMap((part, i) => (i ? [<wbr key={i} />, part] : [part]));

// the rows behind "Details", in the order an operator reads them
function details(
  r: Summary["runtime"],
  upFor: number | null,
): [string, string][] {
  const rows: [string, string | null | undefined][] = r.pod
    ? [
        ["Region", r.region],
        ["Zone", r.zone],
        ["Node", r.node],
        ["Namespace", r.namespace],
        ["Pod", r.pod],
        ["Pod IP", r.ip],
      ]
    : [
        ["Region", r.region],
        ["Zone", r.zone],
        ["Host", r.host],
        ["IP", r.ip],
      ];
  if (upFor !== null) rows.push(["Uptime", uptime(upFor)]);
  return rows.filter((row): row is [string, string] => !!row[1]);
}

// one line that says whether everything answers, with each check behind it
function Health({ link, index }: { link: Link; index: Summary["index"] }) {
  const checks = healthChecks(link.checks, index);
  const h = healthLine(checks);
  return (
    <details className="group rounded-2xl bg-white dark:bg-gray-900">
      <summary className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-2xl cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        {h.ok ? (
          <CheckCircleIcon
            className="size-5 shrink-0 text-green-600 dark:text-green-400"
            aria-hidden="true"
          />
        ) : (
          <ExclamationTriangleIcon
            className="size-5 shrink-0 text-red-600 dark:text-red-400"
            aria-hidden="true"
          />
        )}
        <span className="flex-1 min-w-0">
          <span
            className={`block ${h.ok ? "text-gray-900 dark:text-gray-100" : "text-red-600 dark:text-red-400"}`}
          >
            {h.title}
          </span>
          <span className="block text-xs text-gray-600 dark:text-gray-400">
            {h.line}
          </span>
        </span>
        <ChevronDownIcon
          className="size-4 shrink-0 text-gray-600 dark:text-gray-400 transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <ul className="border-t border-gray-100 dark:border-gray-850 divide-y divide-gray-100 dark:divide-gray-850">
        {checks.map((c) => (
          <li key={c.label} className="flex items-center gap-2 px-3.5 py-2">
            {c.ok === null ? (
              <MinusCircleIcon
                className="size-4 shrink-0 text-gray-600 dark:text-gray-400"
                aria-hidden="true"
              />
            ) : c.ok ? (
              <CheckCircleIcon
                className="size-4 shrink-0 text-green-600 dark:text-green-400"
                aria-hidden="true"
              />
            ) : (
              <XCircleIcon
                className="size-4 shrink-0 text-red-600 dark:text-red-400"
                aria-hidden="true"
              />
            )}
            <span className="flex-1 text-gray-900 dark:text-gray-100">
              {c.label}
            </span>
            <span
              className={`shrink-0 text-xs ${c.ok === false ? "text-red-600 dark:text-red-400" : "text-gray-600 dark:text-gray-400"}`}
            >
              {c.state}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

const SLOTS = 20;
const PACE = {
  fast: "faster than reading",
  read: "reading pace",
  slow: "slower than reading",
};
const PACE_BG = {
  fast: "bg-pace-fast",
  read: "bg-pace-read",
  slow: "bg-pace-slow",
};

// One bar per answer, newest on the right: status pages' moving bars with the size kept. Height
// is the speed, colour whether it keeps up with reading (slow bars also carry a triangle). A new
// answer grows in and, once all slots are full, the row slides one slot left.
function SpeedBars({ speeds }: { speeds: Speed[] }) {
  const measured = speeds
    .filter((x): x is Speed & { tps: number } => x.tps !== null)
    .slice(-SLOTS);
  const newest = measured.at(-1)?.id;
  const [seen, setSeen] = useState(newest);
  const [fresh, setFresh] = useState<string>();
  if (newest !== seen) {
    setSeen(newest);
    setFresh(seen === undefined ? undefined : newest); // the first answers to load are drawn as they are, not grown in
  }
  if (!measured.length)
    return (
      <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
        No speeds yet: they come with answers from a model that reports its
        timing.
      </p>
    );
  const top = Math.max(
    100,
    Math.ceil(Math.max(...measured.map((x) => x.tps)) / 50) * 50,
  );
  const h = 56;
  const at = (v: number) => (v / top) * h;
  const first = speeds.length - measured.length;
  return (
    <div className="mt-2 rounded-2xl bg-white dark:bg-gray-900 px-3.5 py-3">
      <div className="flex items-baseline justify-between text-xs text-gray-600 dark:text-gray-400">
        <span>Last {SLOTS} answers</span>
        <span className="tabular-nums">
          latest {Math.round(measured.at(-1)!.tps)} tokens/s
        </span>
      </div>
      <div
        role="img"
        aria-label={`Output speed of the last ${measured.length} answers, oldest first: ${measured.map((x) => `${Math.round(x.tps)} (${PACE[paceBand(x.tps)]})`).join(", ")} tokens per second`}
        className="relative mt-2 overflow-hidden"
        style={{ height: h }}
      >
        {[READ_TPS, SLOW_TPS].map((v) => (
          <div
            key={v}
            className="absolute inset-x-0 border-t border-dashed border-gray-600 dark:border-gray-400"
            style={{ bottom: at(v) }}
          />
        ))}
        <div
          key={fresh}
          className={`relative flex h-full items-end gap-[2px] ${fresh && measured.length === SLOTS ? "animate-slide-in motion-reduce:animate-none" : ""}`}
        >
          {Array.from({ length: SLOTS - measured.length }, (_, i) => (
            <div
              key={`empty-${i}`}
              className="flex-1 h-[3px] rounded-[2px] bg-gray-100 dark:bg-gray-800"
            />
          ))}
          {measured.map((x, i) => {
            const band = paceBand(x.tps);
            return (
              <div
                key={x.id}
                title={`Answer ${first + i + 1}: ${Math.round(x.tps)} tokens/s, ${PACE[band]}`}
                className="flex-1 flex flex-col items-center justify-end h-full"
              >
                {band === "slow" && (
                  <span
                    aria-hidden="true"
                    className="mb-0.5 text-[8px] leading-none text-pace-slow"
                  >
                    ▲
                  </span>
                )}
                <div
                  className={`w-full rounded-t-[3px] ${PACE_BG[band]} ${x.id === fresh ? "origin-bottom animate-grow motion-reduce:animate-none" : ""}`}
                  style={{ height: Math.max(3, at(x.tps)) }}
                />
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-gray-600 dark:text-gray-400">
        <span>oldest</span>
        <span>dashed: 16 and 5 tokens/s</span>
        <span>newest</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-600 dark:text-gray-400">
        {(["fast", "read", "slow"] as const).map((b) => (
          <span key={b} className="flex items-center gap-1">
            <i className={`inline-block size-2 rounded-[2px] ${PACE_BG[b]}`} />
            {b === "slow" && "▲ "}
            {PACE[b][0].toUpperCase() + PACE[b].slice(1)}
          </span>
        ))}
      </div>
    </div>
  );
}

const MARKS: Record<Kind, React.ReactNode> = {
  ok: (
    <CheckCircleIcon
      className="size-4 shrink-0 text-green-600 dark:text-green-400"
      aria-hidden="true"
    />
  ),
  bad: (
    <XCircleIcon
      className="size-4 shrink-0 text-red-600 dark:text-red-400"
      aria-hidden="true"
    />
  ),
  move: (
    <ArrowsRightLeftIcon
      className="size-4 shrink-0 text-gray-600 dark:text-gray-400"
      aria-hidden="true"
    />
  ),
  doc: (
    <DocumentTextIcon
      className="size-4 shrink-0 text-gray-600 dark:text-gray-400"
      aria-hidden="true"
    />
  ),
};

// what this tab saw happen since it loaded, newest first, with the clock time
function Activity() {
  const events = useActivity();
  return (
    <>
      <h3 className="mt-4 mb-1.5 text-xs text-gray-600 dark:text-gray-400">
        Activity
      </h3>
      {events.length ? (
        <ol className="rounded-2xl bg-white dark:bg-gray-900 divide-y divide-gray-100 dark:divide-gray-850">
          {events.map((e) => {
            const at = new Date(e.at);
            return (
              <li key={e.id} className="flex items-start gap-2 px-3.5 py-2">
                {MARKS[e.kind]}
                <span className="flex-1 min-w-0 text-[13px] leading-4 text-gray-900 dark:text-gray-100">
                  {e.text}
                </span>
                <time
                  dateTime={at.toISOString()}
                  title={at.toLocaleString([], {
                    dateStyle: "full",
                    timeStyle: "short",
                  })}
                  className="shrink-0 text-xs leading-4 tabular-nums text-gray-600 dark:text-gray-400"
                >
                  {eventTime(at)}
                </time>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="rounded-2xl bg-white dark:bg-gray-900 px-3.5 py-2.5 text-xs text-gray-600 dark:text-gray-400">
          No activity yet
        </p>
      )}
    </>
  );
}

// where the model runs and how fast it has been answering, medians of the last 5 answers
function ModelCard({
  model,
  speeds,
}: {
  model: NonNullable<Summary["model"]>;
  speeds: Speed[] | null;
}) {
  const recent = (speeds ?? []).slice(-5);
  const tps = median(recent.flatMap((x) => (x.tps === null ? [] : [x.tps])));
  const ttft = median(recent.flatMap((x) => (x.ttft === null ? [] : [x.ttft])));
  return (
    <>
      <h3 className="mt-4 mb-1.5 text-xs text-gray-600 dark:text-gray-400">
        Model
      </h3>
      <dl className="rounded-2xl bg-white dark:bg-gray-900 divide-y divide-gray-100 dark:divide-gray-850">
        <Row label="Runs">{runsLabel(model.provider, model.host)}</Row>
        {model.endpoint && (
          <Row label="Endpoint">
            <span>{breakable(model.endpoint)}</span>
          </Row>
        )}
        {model.resolved && <Row label="Resolved">{model.resolved}</Row>}
        {speeds && (
          <>
            <Row label="Output speed">
              <span title="Median of the last 5 answers">
                {tps === null
                  ? "No answers yet"
                  : `${Math.round(tps)} tokens/s`}
              </span>
            </Row>
            <Row label="Time to first token">
              <span title="Median of the last 5 answers">
                {ttft === null ? "No answers yet" : `${ttft.toFixed(1)} s`}
              </span>
            </Row>
          </>
        )}
      </dl>
      {speeds && <SpeedBars speeds={speeds} />}
    </>
  );
}

export default function StatusPanel({
  link,
  refresh,
  onClose,
}: {
  link: Link | null;
  refresh: number;
  onClose: () => void;
}) {
  const [s, setS] = useState<Summary | null | undefined>();
  const [loadedAt, setLoadedAt] = useState(0);
  const [now, setNow] = useState(0);
  useEffect(() => {
    get<Summary>("rag.status.summary")
      .then((x) => {
        setS(x);
        setLoadedAt(Date.now());
        setNow(Date.now());
      })
      .catch(() => setS(null));
  }, [refresh]);
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(clock);
  }, []);
  const place = link ? PLACES[link.location] : undefined;
  const runtime = s?.platform.runtime
    ? PLATFORMS[s.platform.runtime]
    : undefined;
  // the server's uptime at load, counted on here so it ticks with each second
  const upFor =
    s?.runtime.uptime_s != null
      ? s.runtime.uptime_s + (now - loadedAt) / 1000
      : null;
  const more = s ? details(s.runtime, upFor) : [];
  const shown = [link?.location, s?.platform.runtime].filter(
    (k): k is string => !!k && k in NOTICE,
  );
  // the panel takes the focus when it opens: the button that opened it is gone either way, and on a
  // phone it is a sheet, which closes on Esc like Open WebUI's Drawer
  // once per opening: App hands a new onClose every render, and it renders with each second's poll
  const close = useRef<HTMLButtonElement>(null);
  const latestClose = useRef(onClose);
  useEffect(() => {
    latestClose.current = onClose;
  });
  useEffect(() => {
    const phone = window.matchMedia("(max-width: 47.999rem)");
    close.current?.focus();
    const esc = (e: KeyboardEvent) =>
      e.key === "Escape" && phone.matches && latestClose.current();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  return (
    <>
      {/* on a phone the panel is a bottom sheet over the dimmed chat, closed by a tap on the dim or Esc */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className="md:hidden fixed inset-0 z-30 bg-black/60"
      />
      {/* motion-safe, not a separate motion-reduce:animate-none: Tailwind 4.3.3 emits max-* after motion-reduce */}
      <aside
        aria-label="Status"
        className="max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-40 max-md:h-[80dvh] max-md:rounded-t-3xl max-md:motion-safe:animate-sheet-up md:w-(--panel-width) md:h-full shrink-0 overflow-y-auto bg-gray-50 dark:bg-gray-950 text-gray-700 dark:text-gray-300"
      >
        <div
          aria-hidden="true"
          className="md:hidden mx-auto mt-2 h-1 w-10 rounded-full bg-gray-300 dark:bg-gray-700"
        />
        {/* the left sidebar's header, mirrored: the toggle on the inner edge, then the name */}
        <div className="flex items-center gap-2 pl-2 pr-3 h-12">
          <button
            ref={close}
            aria-label="Close status panel"
            aria-expanded={true}
            onClick={onClose}
            className="grid place-items-center size-8 rounded-xl hover:bg-black/5 dark:hover:bg-white/5"
          >
            <PanelIcon
              side="right"
              action="close"
              className="size-4 max-md:hidden"
            />
            <XMarkIcon className="md:hidden size-5" />
          </button>
          <h2 className="flex-1 text-[13px] leading-5 dark:text-gray-200">
            Status
          </h2>
        </div>
        <div className="px-3.5 py-3 text-sm">
          {s === undefined || !link ? (
            <p className="text-xs text-gray-600 dark:text-gray-400">Loading…</p>
          ) : s === null ? (
            <>
              <p className="text-xs text-gray-600 dark:text-gray-400">
                Status is unavailable right now.
              </p>
              <Activity />
            </>
          ) : (
            <>
              <Health link={link} index={s.index} />
              <h3 className="mt-4 mb-1.5 text-xs text-gray-600 dark:text-gray-400">
                Running on
              </h3>
              <div className="rounded-2xl bg-white dark:bg-gray-900">
                <dl className="divide-y divide-gray-100 dark:divide-gray-850">
                  <Row label="Provider">
                    {place && <BrandMark mark={place.mark} />}
                    {place?.name ?? "Unknown"}
                  </Row>
                  <Row label="Platform">
                    {runtime ? (
                      <span
                        className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 ${runtime.chip}`}
                      >
                        <BrandMark mark={runtime.mark} ink={runtime.ink} />
                        {runtime.name}
                      </span>
                    ) : (
                      "Not detected"
                    )}
                  </Row>
                </dl>
              </div>
              {/* the server's own facts, a block of their own under where it runs */}
              {more.length > 0 && (
                <>
                  <h3 className="mt-4 mb-1.5 text-xs text-gray-600 dark:text-gray-400">
                    Details
                  </h3>
                  <dl className="rounded-2xl bg-white dark:bg-gray-900 divide-y divide-gray-100 dark:divide-gray-850">
                    {more.map(([k, v]) => (
                      <Row key={k} label={k}>
                        <span>{breakable(v)}</span>
                      </Row>
                    ))}
                  </dl>
                </>
              )}
              {s.model && <ModelCard model={s.model} speeds={s.speeds} />}
              <Activity />
              {shown.length > 0 && (
                <details className="group mt-6 text-[11px] leading-snug text-gray-600 dark:text-gray-400">
                  <summary className="flex w-fit items-center gap-1 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                    Trademark notice
                    <ChevronDownIcon
                      className="size-3 transition-transform group-open:rotate-180"
                      aria-hidden="true"
                    />
                  </summary>
                  <p className="mt-1">
                    {[...new Set(shown.map((k) => NOTICE[k]))].join(" ")} Metis
                    is not affiliated with these companies; the names show where
                    it runs.
                  </p>
                </details>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
