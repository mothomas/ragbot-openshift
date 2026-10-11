import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attach, driveUpload, get, list, post, requestId } from "./frappe";

// The two direct callers, SignIn's login POST and Documents' text preview, spread requestId() into their
// own fetch; everything else goes through send() or driveUpload, which are what this covers.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEADER = "X-Frappe-Request-Id";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

const sent = (fetch: ReturnType<typeof vi.fn>, call: number): Headers =>
  new Headers((fetch.mock.calls[call][1] as RequestInit).headers);

beforeEach(() => vi.stubGlobal("window", {}));
afterEach(() => vi.unstubAllGlobals());

describe("every request Metis makes carries a request id", () => {
  it("is a uuid, which is the only shape Frappe's monitor adopts", () => {
    // frappe/monitor.py TRACE_ID_PATTERN is [0-9a-fA-F-]{8,64} under fullmatch, so a uuid qualifies
    expect(requestId()[HEADER]).toMatch(UUID);
    expect(requestId()[HEADER]).not.toBe(requestId()[HEADER]);
  });

  it("sends none where the platform cannot mint one, rather than failing the request", () => {
    // crypto.randomUUID is [SecureContext]: absent on plain http outside localhost
    vi.stubGlobal("crypto", {});
    expect(requestId()).toEqual({});
  });

  it("puts one on each call the Frappe client makes", async () => {
    const fetch = vi.fn(async () => json({ message: {}, data: [] }));
    vi.stubGlobal("fetch", fetch);
    await get("rag.status.probe");
    await post("frappe_ai.api.chat.start_stream", { message: "hello" });
    await list("File", { fields: ["name"] });
    await attach("s1", new File(["hello"], "a.txt"));

    const ids = fetch.mock.calls.map((_, i) => sent(fetch, i).get(HEADER));
    expect(ids).toHaveLength(4);
    for (const id of ids) expect(String(id)).toMatch(UUID);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("puts one on a Drive upload, which is sent by XMLHttpRequest", async () => {
    const headers: Record<string, string> = {};
    vi.stubGlobal(
      "XMLHttpRequest",
      class {
        upload = {};
        status = 200;
        responseText = JSON.stringify({ message: { name: "f1" } });
        onload: (() => void) | null = null;
        open() {}
        setRequestHeader(k: string, v: string) {
          headers[k] = v;
        }
        send() {
          this.onload?.();
        }
      },
    );
    await driveUpload(new File(["hello"], "a.txt"), "team", "parent", () => {});
    expect(String(headers[HEADER])).toMatch(UUID);
  });
});
