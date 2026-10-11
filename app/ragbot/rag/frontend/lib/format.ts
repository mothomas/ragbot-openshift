export function relativeDay(when: Date, now = new Date()): string {
  const day = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(when)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days <= 7) return "Previous 7 days";
  if (days <= 30) return "Previous 30 days";
  // then Open WebUI's month of this year, or the year
  return when.getFullYear() === now.getFullYear()
    ? when.toLocaleString("en-US", { month: "long" })
    : String(when.getFullYear());
}

// unit symbols after a no-break space, as the Microsoft and Google style guides and NIST SP 811 write them
const unit = (n: number, u: string) => `${n}\u00a0${u}`;

// Open WebUI's message times: the time today, "Yesterday at" it, else the date "at" it
export function eventTime(at: Date, now = new Date()): string {
  const time = at.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const day = relativeDay(at, now);
  return day === "Today"
    ? time
    : day === "Yesterday"
      ? `Yesterday at ${time}`
      : `${at.toLocaleDateString()} at ${time}`;
}

export function seconds(n: number): string {
  if (n < 1) return `under ${unit(1, "s")}`;
  const s = Math.round(n);
  return s < 60
    ? unit(s, "s")
    : `${unit(Math.floor(s / 60), "min")} ${unit(s % 60, "s")}`;
}

export function bytes(n: number | null | undefined): string {
  if (!n) return "";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(n) / Math.log(1024)),
  );
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function ago(when: Date, now = new Date()): string {
  const m = Math.floor((now.getTime() - when.getTime()) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

// Frappe stores naive datetimes in the site's time zone; read them there, not in the browser's.
export function fromServer(s: string, zone: string): Date {
  const asIfUtc = new Date(s.replace(" ", "T").slice(0, 23) + "Z");
  // the zone's own clock as numbers. Formatting it and parsing the string back would go through
  // the browser's zone, which is an hour out on the days the browser's own zone switches.
  const offset = (at: Date) => {
    const p: Record<string, string> = {};
    for (const { type, value } of new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(at))
      p[type] = value;
    const wall = Date.UTC(
      +p.year,
      +p.month - 1,
      +p.day,
      +p.hour,
      +p.minute,
      +p.second,
    );
    return wall - (at.getTime() - at.getUTCMilliseconds());
  };
  // the offset read at the naive time can be the wrong side of a daylight saving switch;
  // read again at the first estimate, which is on the right side
  const estimate = new Date(asIfUtc.getTime() - offset(asIfUtc));
  return new Date(asIfUtc.getTime() - offset(estimate));
}

// Formats a value in an agent block. The agent sends currency as raw numbers and percent on a 0-100 scale.
export function fmt(v: unknown, format = "text", currency?: string): string {
  if (typeof v !== "number") {
    if (format === "date" && typeof v === "string")
      return new Date(v.length === 10 ? `${v}T00:00` : v).toLocaleDateString();
    return v == null ? "" : String(v);
  }
  if (format === "currency" && currency)
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      trailingZeroDisplay: "stripIfInteger",
    }).format(v);
  if (format === "percent")
    return new Intl.NumberFormat(undefined, {
      style: "percent",
      maximumFractionDigits: 1,
    }).format(v / 100);
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function median(xs: number[]): number | null {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null;
}

// What a failed request says when Frappe sends no message of its own: one sentence per status,
// each saying what to do next. Frappe's `exception` field is the last line of a traceback, so it
// never reaches a reader.
const FAILURES: Record<number, string> = {
  401: "Session expired. Please sign in again.",
  403: "You do not have permission to do that. Ask the owner for access.",
  404: "That is no longer there. Refresh the page and try again.",
  413: "That file is too large to upload. Try a smaller file.",
  429: "Too many requests. Wait a moment and try again.",
};
export function failureMessage(status: number): string {
  return (
    FAILURES[status] ??
    (status >= 500
      ? "The server could not finish that. Try again in a moment."
      : "That request did not go through. Try again.")
  );
}

// null is unknown: the agent reports on the tools server and the model, and skips hosted models
export type Checks = {
  agent: boolean | null;
  tools: boolean | null;
  model: boolean | null;
};
type Check = {
  label: string;
  ok: boolean | null;
  state: string;
  problem?: string;
};

export function healthChecks(
  c: Checks,
  index?: { chunks: number; ok: boolean },
): Check[] {
  const service = (label: string, ok: boolean | null): Check => ({
    label,
    ok,
    state: ok === null ? "Unknown" : ok ? "Up" : "Down",
    problem: `${label} down`,
  });
  return [
    service("Agent", c.agent),
    service("Model", c.model),
    service("MCP server", c.tools),
    {
      label: "Search index",
      ok: index?.ok ?? null,
      state: !index
        ? "Unknown"
        : !index.ok
          ? "Needs rebuild"
          : index.chunks
            ? `${index.chunks} ${index.chunks === 1 ? "chunk" : "chunks"}`
            : "Empty",
      problem: "Search index needs a rebuild",
    },
  ];
}

export function healthLine(checks: Check[]): {
  ok: boolean;
  title: string;
  line: string;
} {
  const failed = checks.filter((c) => c.ok === false);
  if (failed.length) {
    // later problems lose their capital, but an acronym like MCP keeps its case
    const lower = (p: string) =>
      p[1] === p[1].toLowerCase() ? p[0].toLowerCase() + p.slice(1) : p;
    return {
      ok: false,
      title: "Degraded",
      line: failed
        .map((c, i) => (i ? lower(c.problem!) : c.problem!))
        .join(", "),
    };
  }
  const passed = checks.filter((c) => c.ok).length;
  const line =
    passed === checks.length
      ? `All ${passed} checks pass`
      : `${passed} of ${checks.length} checks pass, ${checks.length - passed} unknown`;
  return { ok: true, title: "Healthy", line };
}

// the top-bar chip: the round trip, or which way it fails. "Offline" only means this device has
// no network (Microsoft's style guide); a server that answers without a dependency is "Degraded"
export function chipReading(
  ok: boolean,
  rttMs: number | null,
  agent: boolean | null,
  online: boolean,
): string {
  if (ok && rttMs !== null)
    return `${rttMs < 10 ? rttMs.toFixed(1) : Math.round(rttMs)} ms`;
  if (!online) return "Offline";
  return agent ? "Degraded" : "Down";
}

// the chip's hover: what its number is, or why there is none
export function chipTip(ok: boolean, checks: Checks, online: boolean): string {
  if (ok) return "Round trip to the agent";
  if (!online) return "No network connection";
  const h = healthLine(healthChecks(checks));
  return h.ok ? "Can't reach the Metis server" : h.line;
}

// how long the server has run, in the two largest units, like "2 h 14 min"
export function uptime(s: number): string {
  if (s < 60) return unit(Math.floor(s), "s");
  const m = Math.floor(s / 60),
    h = Math.floor(m / 60),
    d = Math.floor(h / 24);
  return d
    ? `${unit(d, "d")} ${unit(h % 24, "h")}`
    : h
      ? `${unit(h, "h")} ${unit(m % 60, "min")}`
      : unit(m, "min");
}

// Reading speed sets the bands: 5 tokens/s is 238 words a minute at 1.33 tokens a word (Brysbaert 2019),
// and 16 stays comfortable for 99% of readers on complex text (arXiv 2504.17999).
export const SLOW_TPS = 5;
export const READ_TPS = 16;
export const paceBand = (tps: number) =>
  tps < SLOW_TPS ? "slow" : tps < READ_TPS ? "read" : "fast";

// the composer's hover on the model's name: where it runs, and for Ollama the context window the
// agent asks for (a hosted provider sets its own)
export type Runs = {
  provider: string | null;
  host: string | null;
  context: number | null;
};
export function modelTip(r: Runs | null | undefined): string {
  if (!r) return "";
  const runs = runsLabel(r.provider, r.host);
  return r.provider === "ollama" && r.context
    ? `${runs} · ${r.context.toLocaleString()}-token context window`
    : runs;
}

// the agent's AI_AGENT_LLM_PROVIDER values, spelled as each company writes its name
const BRANDS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
};

// where the agent's model runs, from its provider and the host its base URL names
export function runsLabel(
  provider: string | null,
  host: string | null,
): string {
  if (provider !== "ollama")
    return `Hosted (${BRANDS[provider ?? ""] ?? provider ?? "unknown"})`;
  if (host === "host.docker.internal") return "Native on the host";
  if (host === "ollama") return "Ollama container";
  return `Ollama on ${host ?? "an unknown host"}`;
}
