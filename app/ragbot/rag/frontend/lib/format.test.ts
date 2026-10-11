import { describe, expect, it } from "vitest";
import {
  ago,
  bytes,
  chipReading,
  chipTip,
  eventTime,
  fmt,
  modelTip,
  paceBand,
  runsLabel,
  uptime,
  fromServer,
  healthChecks,
  healthLine,
  median,
  relativeDay,
  seconds,
} from "./format";

describe("relativeDay", () => {
  const now = new Date("2026-09-18T12:00:00");
  it("buckets like Open WebUI's sidebar", () => {
    expect(relativeDay(new Date("2026-09-18T01:00:00"), now)).toBe("Today");
    expect(relativeDay(new Date("2026-09-17T23:00:00"), now)).toBe("Yesterday");
    expect(relativeDay(new Date("2026-09-13T10:00:00"), now)).toBe(
      "Previous 7 days",
    );
    expect(relativeDay(new Date("2026-08-25T10:00:00"), now)).toBe(
      "Previous 30 days",
    );
    expect(relativeDay(new Date("2026-08-01T10:00:00"), now)).toBe("August");
    expect(relativeDay(new Date("2025-12-31T10:00:00"), now)).toBe("2025");
  });
});

describe("eventTime", () => {
  const now = new Date("2026-09-19T12:00:00");
  it("says the day only when it isn't today", () => {
    const time = (d: Date) =>
      d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const today = new Date("2026-09-19T10:42:00");
    const yesterday = new Date("2026-09-18T10:42:00");
    const older = new Date("2026-09-10T10:42:00");
    expect(eventTime(today, now)).toBe(time(today));
    expect(eventTime(yesterday, now)).toBe(`Yesterday at ${time(yesterday)}`);
    expect(eventTime(older, now)).toBe(
      `${older.toLocaleDateString()} at ${time(older)}`,
    );
  });
});

describe("seconds", () => {
  it("reads as a short duration", () => {
    expect(seconds(0.4)).toBe("under 1\u00a0s");
    expect(seconds(4.2)).toBe("4\u00a0s");
    expect(seconds(75)).toBe("1\u00a0min 15\u00a0s");
  });
});

describe("bytes", () => {
  it("uses the largest whole unit", () => {
    expect(bytes(null)).toBe("");
    expect(bytes(48)).toBe("48 B");
    expect(bytes(1635)).toBe("1.6 KB");
  });
});

describe("ago", () => {
  const now = new Date("2026-09-18T12:00:00");
  it("is the short age Open WebUI shows beside a chat", () => {
    expect(ago(new Date("2026-09-18T11:59:40"), now)).toBe("now");
    expect(ago(new Date("2026-09-18T11:15:00"), now)).toBe("45m");
    expect(ago(new Date("2026-09-18T09:00:00"), now)).toBe("3h");
    expect(ago(new Date("2026-09-15T12:00:00"), now)).toBe("3d");
  });
});

describe("fromServer", () => {
  it("reads Frappe's naive datetimes in the site's zone, not the browser's", () => {
    // Adelaide is UTC+9:30 in September: 20:30:40 there is 11:00:40 UTC
    expect(
      fromServer(
        "2026-09-18 20:30:40.749836",
        "Australia/Adelaide",
      ).toISOString(),
    ).toBe("2026-09-18T11:00:40.749Z");
    expect(
      fromServer("2026-01-18 20:30:40", "Australia/Adelaide").toISOString(),
    ).toBe("2026-01-18T10:00:40.000Z");
    expect(fromServer("2026-09-18 20:30:40", "UTC").toISOString()).toBe(
      "2026-09-18T20:30:40.000Z",
    );
  });
  it("takes the offset in force at that moment, even hours before a daylight saving switch", () => {
    // Adelaide moves to +10:30 at 02:00 on 4 October 2026; 20:00 the evening before is still +9:30
    expect(
      fromServer("2026-10-03 20:00:00", "Australia/Adelaide").toISOString(),
    ).toBe("2026-10-03T10:30:00.000Z");
    expect(
      fromServer("2026-10-04 12:00:00", "Australia/Adelaide").toISOString(),
    ).toBe("2026-10-04T01:30:00.000Z");
  });
});

describe("fmt", () => {
  it("follows the agent's block formats: raw currency numbers, percent on a 0-100 scale", () => {
    expect(fmt(1180000, "currency", "AUD")).toBe(
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "AUD",
        maximumFractionDigits: 0,
      }).format(1180000),
    );
    expect(fmt(12.5, "percent")).toBe(
      new Intl.NumberFormat(undefined, {
        style: "percent",
        maximumFractionDigits: 1,
      }).format(0.125),
    );
    expect(fmt(1234.567, "number")).toBe(
      (1234.567).toLocaleString(undefined, { maximumFractionDigits: 2 }),
    );
    expect(fmt("45 AUD", "currency", "AUD")).toBe("45 AUD");
    expect(fmt(null)).toBe("");
  });
  it("keeps cents, and drops them only from whole amounts", () => {
    expect(fmt(0.88, "currency", "AUD")).toContain("0.88");
    expect(fmt(45.5, "currency", "AUD")).toContain("45.50");
    expect(fmt(45, "currency", "AUD")).not.toContain(".");
  });
  it("reads a date-only value as that calendar day in every zone", () => {
    expect(fmt("2026-09-18", "date")).toBe(
      new Date(2026, 8, 18).toLocaleDateString(),
    );
  });
});

describe("median", () => {
  it("takes the middle answer time, or the mean of the middle two", () => {
    expect(median([])).toBeNull();
    expect(median([30, 10, 20])).toBe(20);
    expect(median([40, 10, 30, 20])).toBe(25);
  });
});

describe("health", () => {
  const up = { agent: true, tools: true, model: true };
  const index = { chunks: 7, ok: true };
  it("passes when every check answers", () => {
    const c = healthChecks(up, index);
    expect(c.map((x) => [x.label, x.state])).toEqual([
      ["Agent", "Up"],
      ["Model", "Up"],
      ["MCP server", "Up"],
      ["Search index", "7 chunks"],
    ]);
    expect(healthLine(c)).toEqual({
      ok: true,
      title: "Healthy",
      line: "All 4 checks pass",
    });
  });
  it("names what failed", () => {
    expect(healthLine(healthChecks({ ...up, tools: false }, index)).line).toBe(
      "MCP server down",
    );
    const c = healthChecks(
      { ...up, tools: false, model: false },
      { chunks: 7, ok: false },
    );
    expect(c[3].state).toBe("Needs rebuild");
    expect(healthLine(c).line).toBe(
      "Model down, MCP server down, search index needs a rebuild",
    );
  });
  it("never claims what nobody checked", () => {
    // the agent is down, so nobody asked the tools server or the model
    const c = healthChecks({ agent: false, tools: null, model: null }, index);
    expect(c.map((x) => x.state)).toEqual([
      "Down",
      "Unknown",
      "Unknown",
      "7 chunks",
    ]);
    expect(healthLine(c)).toEqual({
      ok: false,
      title: "Degraded",
      line: "Agent down",
    });
    // a hosted model is not probed
    expect(healthLine(healthChecks({ ...up, model: null }, index)).line).toBe(
      "3 of 4 checks pass, 1 unknown",
    );
    expect(healthChecks(up, { chunks: 0, ok: true })[3].state).toBe("Empty");
    expect(healthChecks(up, { chunks: 1, ok: true })[3].state).toBe("1 chunk");
  });
});

describe("chipTip", () => {
  const up = { agent: true, tools: true, model: true };
  it("says what the number is, or why there is none", () => {
    expect(chipTip(true, up, true)).toBe("Round trip to the agent");
    expect(chipTip(false, { ...up, tools: false }, true)).toBe(
      "MCP server down",
    );
    // the poll itself failed, so nothing was checked
    expect(
      chipTip(false, { agent: null, tools: null, model: null }, true),
    ).toBe("Can't reach the Metis server");
    expect(
      chipTip(false, { agent: null, tools: null, model: null }, false),
    ).toBe("No network connection");
  });
});

describe("chipReading", () => {
  it("is the round trip, or which way it is failing", () => {
    expect(chipReading(true, 3.64, true, true)).toBe("3.6 ms");
    expect(chipReading(true, 41.2, true, true)).toBe("41 ms");
    // the agent answers but something it needs does not
    expect(chipReading(false, null, true, true)).toBe("Degraded");
    expect(chipReading(false, null, false, true)).toBe("Down");
    expect(chipReading(false, null, null, true)).toBe("Down");
    // "offline" is for this device having no network, and nothing else
    expect(chipReading(false, null, null, false)).toBe("Offline");
  });
});

describe("uptime", () => {
  it("shows the two largest units", () => {
    expect(uptime(9)).toBe("9\u00a0s");
    expect(uptime(14 * 60 + 5)).toBe("14\u00a0min");
    expect(uptime(2 * 3600 + 14 * 60)).toBe("2\u00a0h 14\u00a0min");
    expect(uptime(3 * 86400 + 4 * 3600 + 59)).toBe("3\u00a0d 4\u00a0h");
  });
});

describe("paceBand", () => {
  it("compares an answer's speed with reading speed", () => {
    expect(paceBand(4.9)).toBe("slow");
    expect(paceBand(5)).toBe("read");
    expect(paceBand(15.9)).toBe("read");
    expect(paceBand(16)).toBe("fast");
  });
});

describe("modelTip", () => {
  it("says where the model runs, and Ollama's context window", () => {
    expect(
      modelTip({
        provider: "ollama",
        host: "host.docker.internal",
        context: 16384,
      }),
    ).toBe(
      `Native on the host · ${(16384).toLocaleString()}-token context window`,
    );
    expect(
      modelTip({ provider: "openai", host: "api.openai.com", context: 16384 }),
    ).toBe("Hosted (OpenAI)");
    expect(modelTip(null)).toBe("");
  });
});

describe("runsLabel", () => {
  it("says where the model runs", () => {
    expect(runsLabel("ollama", "host.docker.internal")).toBe(
      "Native on the host",
    );
    expect(runsLabel("ollama", "ollama")).toBe("Ollama container");
    expect(runsLabel("ollama", "gpu-box.lan")).toBe("Ollama on gpu-box.lan");
    expect(runsLabel("openai", null)).toBe("Hosted (OpenAI)");
  });
});
