"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyChunk,
  fromHistory,
  newTurn,
  quietDelay,
  resumed,
  savedRefs,
  withExcerpts,
  type Ask,
  type Chunk,
  type Row,
  type Source,
  type Turn,
} from "./chat";
import { boot, FrappeError, list, post } from "./frappe";
import { FRAPPE_AI } from "./peers";
import type { Socket } from "socket.io-client";

const NO_REPLY = "No reply from the assistant. Try again.";
const why = (e: unknown) =>
  e instanceof FrappeError ? e.message : "Could not reach the server.";

/** The user's own answer to a paused write: the only thing the browser may say about one. */
export const respond = (id: string, decision: "allow" | "deny") =>
  post<{ ok: boolean }>(FRAPPE_AI.respond, {
    confirmation_id: id,
    decision,
  });

// the relay publishes a stopped answer's end only when the agent's next line arrives, and the agent sends no
// keepalive, so this is how long a question waits rather than take that end for its own
const STOP_LIMIT_MS = 5_000;

// An answer saves where it read each passage. The text comes back here, under this reader's own
// permissions, so a document they have since lost shows as gone rather than from the copy they were shown.
async function readBack(turns: Turn[]): Promise<Turn[]> {
  const refs = savedRefs(turns);
  if (!refs.length) return turns;
  try {
    return withExcerpts(
      turns,
      await post<Source[]>("rag.search.passages", { refs }),
    );
  } catch {
    // the excerpts did not arrive, which is not the same as no longer being allowed to read them
    return turns;
  }
}

/** The 500 newest user and assistant rows of a chat, oldest first: past that a chat keeps its end, not its start. */
export async function history(session: string): Promise<Row[]> {
  const rows = await list<Row>(FRAPPE_AI.message, {
    fields: [
      "name",
      "role",
      "content",
      "created_at",
      "tool_args_json",
      "tool_result_json",
    ],
    // the roles fromHistory keeps, so the limit counts turns a reader sees rather than tool rows
    filters: [
      ["session", "=", session],
      ["role", "in", ["user", "assistant"]],
    ],
    order_by: "created_at desc",
    limit: 500,
  });
  return rows.reverse();
}

export function useChat(sessionId: string) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [stopping, setStopping] = useState(false);
  const stop = useRef<() => void | Promise<void>>(() => {});
  const detach = useRef<() => void>(() => {});
  // a pause is as much this chat's turn as a running answer: S13 refuses a second answer for the same
  // reason a pending confirmation refuses a second question
  const pending = turns.some((t) => t.ask?.state === "waiting");
  const running = turns.at(-1)?.status === "running" || stopping || pending;

  // one answer: its listener on the chat's channel, its quiet timer, and the Stop that ends it
  const listen = useCallback(
    (bot: Turn, since: number) => {
      const update = (c: Chunk) =>
        setTurns((t) =>
          t.map((x) => (x.id === bot.id ? applyChunk(x, c, Date.now()) : x)),
        );
      const event = FRAPPE_AI.chunks(sessionId);
      let socket: Socket | null = null;
      let quiet: ReturnType<typeof setTimeout> | undefined;
      let ending: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      let settled = false;
      const unsub = () => {
        socket?.off(event, onChunk);
        socket?.off("disconnect", onDrop);
        clearTimeout(quiet);
        clearTimeout(ending);
      };
      const finish = (c: Chunk) => {
        if (settled) return;
        settled = true;
        update(c);
        unsub();
        setStopping(false);
        stop.current = () => {};
        detach.current = () => {};
      };
      const arm = (lastChunkAt: number) => {
        clearTimeout(quiet);
        quiet = setTimeout(
          () => finish({ type: "error", message: NO_REPLY }),
          quietDelay(lastChunkAt, Date.now()),
        );
      };
      function onChunk(c: Chunk) {
        arm(Date.now());
        // once stopped only this answer's own end still matters: what follows it was written for an answer
        // the user ended
        if (c.type === "done" || c.type === "error")
          finish(stopped ? { type: "stopped" } : c);
        else if (!stopped) update(c);
      }
      // a chunk published while the socket is down is lost, so only the browser can end the turn then
      function onDrop() {
        finish({ type: "error", message: NO_REPLY });
      }
      detach.current = () => {
        settled = true; // the channel can still open after the chat is gone: nothing may subscribe then
        unsub();
      };
      stop.current = () => {
        const again = stop.current;
        stop.current = () => {}; // one cancel per answer: a second would flag the turn after this one
        // the question was never sent, because the channel it answers on never opened: nothing to cancel
        if (!socket) return finish({ type: "stopped" });
        return (
          post(FRAPPE_AI.cancel, { session_id: sessionId })
            .then(() => {
              stopped = true;
              update({ type: "stopped" });
              setStopping(true);
              ending = setTimeout(
                () => finish({ type: "stopped" }),
                STOP_LIMIT_MS,
              );
            })
            // a cancel the server never got leaves the answer running, so the turn stays running too
            .catch(() => {
              stop.current = again;
            })
        );
      };
      arm(since);
      // the wait for the channel comes last: an answer whose channel never opens still has a Stop that ends
      // it and a timer that gives up on it
      // nothing streams into the page until a question is asked, so the socket client is fetched when one is
      const ready = import("./realtime")
        .then((m) => m.realtime())
        .then(
          (s) => {
            if (settled) return false;
            socket = s;
            // subscribe before starting: an event published before the listener exists is lost
            s.on(event, onChunk);
            s.on("disconnect", onDrop);
            return true;
          },
          // without the channel the answer comes back on there is nothing to send the question to
          () => {
            finish({ type: "error", message: "Could not reach the server." });
            return false;
          },
        );
      return { finish, ready };
    },
    [sessionId],
  );

  // <Chat> is keyed by the session, so another chat mounts this hook again: there is no old chat's turns to clear
  useEffect(() => {
    let live = true;
    // the first view Frappe serves draws a chat nobody has opened yet: it has no history to read
    if (sessionId)
      history(sessionId)
        .then(async (rows) => {
          if (!live || !rows.length) return;
          const loaded = await readBack(fromHistory(rows, boot().time_zone));
          if (!live) return;
          const shown = resumed(loaded, Date.now());
          setTurns(shown);
          const waiting = shown.length > loaded.length ? shown.at(-1) : null;
          if (waiting) listen(waiting, waiting.startedAt);
        })
        .catch(() => {
          // the chat is unread, not empty: the landing would say there is nothing to read
          const now = Date.now();
          if (live)
            setTurns([
              applyChunk(
                newTurn("assistant", "", now),
                { type: "error", message: "Failed to load chat" },
                now,
              ),
            ]);
        });
    return () => {
      live = false;
      // leaving a chat does not end its answer: the agent writes it either way, and coming back picks it up
      detach.current();
    };
  }, [sessionId, listen]);

  const send = useCallback(
    async (text: string) => {
      const now = Date.now();
      const bot = newTurn("assistant", "", now);
      setTurns((t) => [...t, newTurn("user", text, now), bot]);
      const { finish, ready } = listen(bot, now);
      if (!(await ready)) return;
      try {
        // without a currency the agent's prompt assumes INR
        const { currency } = boot();
        await post(FRAPPE_AI.start, {
          message: text,
          session_id: sessionId,
          page_context: currency ? { currency } : {},
        });
      } catch (e) {
        finish({ type: "error", message: why(e) });
      }
    },
    [listen, sessionId],
  );

  const settleAsk = useCallback(
    (id: string, state: Ask["state"], message?: string) =>
      setTurns((ts) =>
        ts.map((t) =>
          t.ask?.id === id ? { ...t, ask: { ...t.ask, state, message } } : t,
        ),
      ),
    [],
  );

  const deny = useCallback(
    async (id: string) => {
      try {
        await respond(id, "deny");
        settleAsk(id, "denied");
      } catch (e) {
        settleAsk(id, "expired", why(e));
      }
    },
    [settleAsk],
  );

  const allow = useCallback(
    async (id: string) => {
      const now = Date.now();
      const bot = newTurn("assistant", "", now);
      setTurns((t) => [...t, bot]);
      // the confirmed turn answers on this chat's channel, so subscribe before the click goes out
      const { finish, ready } = listen(bot, now);
      if (!(await ready)) return;
      try {
        await respond(id, "allow");
        // the write was allowed, so the turn it starts is what says what happened
        setTurns((ts) =>
          ts.map((t) => (t.ask?.id === id ? { ...t, ask: undefined } : t)),
        );
      } catch (e) {
        finish({ type: "stopped" });
        setTurns((ts) => ts.filter((x) => x.id !== bot.id));
        settleAsk(id, "expired", why(e));
      }
    },
    [listen, settleAsk],
  );

  const cancel = useCallback(async () => {
    await stop.current();
  }, []);

  return { turns, running, send, cancel, allow, deny };
}
