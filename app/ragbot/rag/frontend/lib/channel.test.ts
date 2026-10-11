import { describe, expect, it, vi } from "vitest";
import { realtime } from "./realtime";

// sockets that can be refused the way Frappe's realtime refuses one (authenticate.js: next(new Error(...))):
// socket.io-client destroys such a socket, leaves active false and never tries it again
const fake = vi.hoisted(() => {
  const made: { refuse: () => void }[] = [];
  return {
    made,
    io: () => {
      const on: Record<string, (e?: unknown) => void> = {};
      const socket = {
        connected: false,
        active: true,
        once: (event: string, fn: (e?: unknown) => void) => {
          on[event] = fn;
        },
        refuse: () => {
          socket.active = false;
          on.connect_error?.(new Error("Invalid origin"));
        },
      };
      made.push(socket);
      return socket;
    },
  };
});
vi.mock("socket.io-client", () => ({ io: fake.io }));

describe("a realtime service that refused the last connection", () => {
  it("is asked for a new one instead of being waited on for good", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("location", { origin: "http://metis.test" });

    const first = realtime();
    fake.made[0].refuse();
    await expect(first).rejects.toThrow("Invalid origin");

    const second = realtime();
    expect(fake.made).toHaveLength(2);
    fake.made[1].refuse();
    await expect(second).rejects.toThrow("Invalid origin");
  });
});
