import { describe, expect, it } from "vitest";
import {
  step,
  WATCH,
  type Reading,
  type Watch,
} from "../components/Connection";
import type { Checks } from "./format";

const up = { agent: true, tools: true, model: true };
const at = (location: string, checks: Checks = up): Reading => ({
  location,
  checks,
});
const lost = at("onprem", { agent: null, tools: null, model: null });
const place = (k: string) =>
  ({ onprem: "On-premises", eks: "Amazon EKS" })[k] ?? k;

// runs readings one second apart, collecting every line and toast
function run(readings: Reading[], start = 0) {
  let w: Watch = WATCH;
  const lines: string[] = [];
  const toasts: string[] = [];
  readings.forEach((r, i) => {
    const s = step(w, r, start + i * 1000, place);
    w = s.watch;
    lines.push(...s.lines.map(([, t]) => t));
    if (s.toast) toasts.push(s.toast);
  });
  return { lines, toasts };
}

describe("step", () => {
  it("says Connected once, then nothing while all stays up", () => {
    expect(run([at("onprem"), at("onprem"), at("onprem")])).toEqual({
      lines: ["Connected"],
      toasts: [],
    });
  });
  it("logs a loss and the return with how long it lasted, toasting like Open WebUI", () => {
    const r = run([at("onprem"), lost, lost, lost, lost, lost, at("onprem")]);
    expect(r.lines).toEqual([
      "Connected",
      "Connection lost",
      "Reconnected after 5 s",
    ]);
    expect(r.toasts).toEqual(["lost", "back"]);
  });
  it("skips both toasts for a blip shorter than Open WebUI's 2 s", () => {
    expect(run([at("onprem"), lost, at("onprem")]).toasts).toEqual([]);
  });
  it("names a move between providers before the reconnect", () => {
    const r = run([at("onprem"), lost, lost, at("eks")]);
    expect(r.lines.slice(-2)).toEqual([
      "Provider changed from On-premises to Amazon EKS",
      "Reconnected after 2 s",
    ]);
  });
  it("logs a dependency going down and up only while connected, ignoring unknowns", () => {
    const r = run([
      at("onprem"),
      at("onprem", { ...up, tools: false }),
      at("onprem", { ...up, tools: true, model: null }),
      at("onprem"),
    ]);
    expect(r.lines).toEqual(["Connected", "MCP server down", "MCP server up"]);
  });
  it("waits for the first answer before saying Connected", () => {
    expect(run([lost, lost, at("onprem")]).lines).toEqual(["Connected"]);
  });
});
