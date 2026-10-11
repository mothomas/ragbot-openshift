import { io, type Socket } from "socket.io-client";
import { boot } from "./frappe";

let socket: Socket | null = null;

// Frappe's realtime namespace is the site name, and it authenticates by the sid cookie,
// which it only accepts when Origin and Host match, which a same-origin page guarantees.
export function realtime(): Promise<Socket> {
  // a refused handshake is final for socket.io-client, which destroys the socket and never retries it, so one
  // kept here after that would hand every later question a connection that can no longer happen
  if (socket && !socket.active && !socket.connected) socket = null;
  socket ??= io(`${location.origin}/${boot().site_name}`, {
    withCredentials: true,
  });
  const s = socket;
  return s.connected
    ? Promise.resolve(s)
    : new Promise((ok, fail) => {
        s.once("connect", () => ok(s));
        // the service is down: without this the caller waits on a promise that never settles
        s.once("connect_error", fail);
      });
}
