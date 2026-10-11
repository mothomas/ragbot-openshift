import { afterEach, describe, expect, it, vi } from "vitest";
import { documents } from "./data";
import { FrappeError, driveUpload, get } from "./frappe";
import { realtime } from "./realtime";

// one socket that never connects, so realtime() has nothing to resolve with
const fake = vi.hoisted(() => {
  const handlers: Record<string, (e?: unknown) => void> = {};
  return {
    handlers,
    socket: {
      connected: false,
      once: (event: string, fn: (e?: unknown) => void) => {
        handlers[event] = fn;
      },
    },
  };
});
vi.mock("socket.io-client", () => ({ io: () => fake.socket }));

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe("failures reach the caller instead of passing as success", () => {
  it("a 2xx page that is not JSON is an error, not an empty answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>sign in</html>", { status: 200 })),
    );
    await expect(get("rag.library.documents")).rejects.toBeInstanceOf(
      FrappeError,
    );
  });

  it("a failed documents load reaches the caller and is tried again next call", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValue(json({ message: [{ name: "a" }] }));
    vi.stubGlobal("fetch", fetch);
    await expect(documents()).rejects.toBeInstanceOf(TypeError);
    expect(await documents()).toEqual([{ name: "a" }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a realtime service that will not connect fails instead of never settling", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("location", { origin: "http://metis.test" });
    const pending = realtime();
    fake.handlers.connect_error?.(new Error("down"));
    await expect(pending).rejects.toThrow("down");
  });

  it("an upload answered with a page that is not JSON settles as a failure", async () => {
    class Xhr {
      status = 200;
      responseText = "<html>proxy</html>";
      upload = {};
      onload = () => {};
      open() {}
      setRequestHeader() {}
      send() {
        this.onload();
      }
    }
    vi.stubGlobal("XMLHttpRequest", Xhr);
    vi.stubGlobal("window", {});
    const file = new File(["x"], "a.txt");
    await expect(
      driveUpload(file, "team", "folder", () => {}),
    ).rejects.toBeInstanceOf(FrappeError);
  });
});
