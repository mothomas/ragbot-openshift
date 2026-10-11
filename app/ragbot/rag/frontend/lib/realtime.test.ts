import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// lib/channel.test.ts covers a refused handshake and lib/failures.test.ts a service that will not
// connect; these are realtime()'s other branches. `active` is socket.io-client's own word for
// "still trying": a refused handshake leaves a socket neither active nor connected, never retried.
type Fake = {
  connected: boolean;
  active: boolean;
  once: (event: string, fn: (arg?: unknown) => void) => void;
  fire: (event: string, arg?: unknown) => void;
};
// vi.hoisted, so the mock factory does not close over a binding that is still in its dead zone
const { io, sockets } = vi.hoisted(() => {
  const made: Fake[] = [];
  const make = vi.fn((url: string, opts: object) => {
    void [url, opts]; // recorded by the spy; realtime() is what decides them
    // once, as socket.io-client means it: several listeners per event, each called at most once
    const handlers: [string, (arg?: unknown) => void][] = [];
    const s: Fake = {
      connected: false,
      active: true,
      once: (event, fn) => void handlers.push([event, fn]),
      fire: (event, arg) => {
        const due = handlers.filter(([e]) => e === event);
        due.forEach((h) => handlers.splice(handlers.indexOf(h), 1));
        due.forEach(([, fn]) => fn(arg));
      },
    };
    made.push(s);
    return s;
  });
  return { io: make, sockets: made };
});
vi.mock("socket.io-client", () => ({ io }));

const load = async () => (await import("./realtime")).realtime;

beforeEach(() => {
  vi.resetModules(); // realtime() keeps one socket per module, so each case needs its own module
  io.mockClear();
  sockets.length = 0;
  vi.stubGlobal("location", { origin: "https://demo.localhost:8080" });
  vi.stubGlobal("window", { boot: { site_name: "demo.localhost" } });
});
afterEach(() => vi.unstubAllGlobals());

describe("realtime", () => {
  it("opens the site's own namespace with the session cookie", async () => {
    const realtime = await load();
    void realtime();
    expect(io).toHaveBeenCalledWith(
      "https://demo.localhost:8080/demo.localhost",
      { withCredentials: true },
    );
  });

  it("waits for the connection and hands back the socket", async () => {
    const realtime = await load();
    const waiting = realtime();
    sockets[0].connected = true;
    sockets[0].fire("connect");
    await expect(waiting).resolves.toBe(sockets[0]);
  });

  it("hands an open socket straight back, without opening a second", async () => {
    const realtime = await load();
    const first = realtime();
    sockets[0].connected = true;
    sockets[0].fire("connect");
    await first;
    await expect(realtime()).resolves.toBe(sockets[0]);
    expect(io).toHaveBeenCalledTimes(1);
  });

  it("two questions asked while it is still connecting share the one socket", async () => {
    const realtime = await load();
    const [a, b] = [realtime(), realtime()];
    expect(io).toHaveBeenCalledTimes(1);
    sockets[0].connected = true;
    sockets[0].fire("connect");
    expect(await a).toBe(await b);
  });

  it("keeps a socket that is still trying to reconnect", async () => {
    const realtime = await load();
    const first = realtime();
    sockets[0].connected = true;
    sockets[0].fire("connect");
    await first;
    // dropped, but the client is retrying: replacing it would throw away the retry
    sockets[0].connected = false;
    void realtime();
    expect(io).toHaveBeenCalledTimes(1);
  });
});
