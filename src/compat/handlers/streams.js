/**
 * Official Hive frontend SSE compatibility handlers.
 *
 * The official client (`core/frontend/src/api/client.ts` `subscribeSse`)
 * opens three process-wide/session streams:
 *
 *   GET /api/sessions/live          -> named `snapshot` events
 *   GET /api/events/global          -> default `message` events
 *   GET /api/sessions/:session/events -> default `message` events
 *
 * The per-session stream is a real bridge to the durable session log:
 * every record in `PI_HIVE_HOME/sessions/<id>/events.jsonl` is replayed as
 * one `event: message` frame, then newly appended lines are tailed while the
 * client stays connected. Records are forwarded verbatim (never fabricated or
 * reshaped); a malformed line is skipped. An unknown session id is a real
 * 404 `unknown_session` instead of an empty stream, because the official
 * client treats that status as "session gone".
 *
 * Handlers are `{req, res, params, ctx}` functions. `ctx` passed at
 * invocation time (the server integration) wins over the `ctx` captured by
 * `registerStreamRoutes`. Supported ctx fields:
 *   - `sessionStore` (or `server.sessionStore`): the durable SessionStore the
 *     session handlers share; otherwise one is built for `ctx.hiveHome ||
 *     PI_HIVE_HOME || hiveHome()`.
 *   - `sessions` or `listSessions`: array or (async) function returning the
 *     live session rows. May also return `{ sessions: [...] }`. When absent,
 *     the durable store's live rows are used (empty when it has none).
 *   - `network`: optional RuntimeNetworkSnapshot (object or function). Only
 *     forwarded when provided; the official client treats it as optional.
 *   - `heartbeatMs`: heartbeat interval override (tests use a small value).
 *   - `eventPollMs`: event-tail poll interval override (default 300ms).
 *
 * Handlers return `{ status, sse: true, stream }` after writing headers.
 * `stream.close()` is idempotent, and both the heartbeat and the event-tail
 * timers are unref'd, so a forgotten client never keeps the process alive.
 */

import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

import { isSafeSessionId } from "../sessions.js";
import { attachSessionContext } from "./sessions.js";
import { ROUTE_STATUS } from "../router.js";

export const SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8";
export const DEFAULT_HEARTBEAT_MS = 15_000;
export const DEFAULT_EVENT_POLL_MS = 300;
export const HEARTBEAT_COMMENT = ": heartbeat\n\n";

const EVENT_READ_CHUNK = 64 * 1024;

/** Route patterns as registered in the compatibility registry. */
export const STREAM_ROUTES = Object.freeze({
  liveSessions: "/api/sessions/live",
  globalEvents: "/api/events/global",
  sessionEvents: "/api/sessions/:session/events",
});

const SSE_HEADERS = Object.freeze({
  "content-type": SSE_CONTENT_TYPE,
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Disable proxy buffering (nginx and friends) so frames flush immediately.
  "x-accel-buffering": "no",
  "access-control-allow-origin": "*",
});

const STREAM_NOTE =
  "SSE streams backed by the durable session store: real stored rows/events, " +
  "never fabricated frames.";

function normalizeHeartbeatMs(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_HEARTBEAT_MS;
}

function normalizePollMs(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_EVENT_POLL_MS;
}

/**
 * Encode one SSE frame. `data` may be a string or a JSON-serializable value;
 * multi-line strings are split into multiple `data:` fields per the SSE
 * grammar. An empty `event` produces the unnamed default (`message`) event.
 */
export function sseFrame(event, data) {
  const payload = typeof data === "string" ? data : JSON.stringify(data ?? null);
  const dataLines = String(payload)
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");
  const eventLine = event ? `event: ${event}\n` : "";
  return `${eventLine}${dataLines}\n\n`;
}

function safeWrite(res, chunk) {
  if (!res || typeof res.write !== "function") return false;
  try {
    res.write(chunk);
    return true;
  } catch {
    return false;
  }
}

/** Comments must stay one line: a newline in a session id must not become SSE syntax. */
function sanitizeComment(text) {
  return String(text).replace(/[\u0000\r\n]/g, " ").slice(0, 200);
}

/**
 * Open an SSE response: write 200 + SSE headers, optionally emit an initial
 * comment, start an unref'd heartbeat, and tear everything down when the
 * request or response closes.
 *
 * @param {object} req Node request (EventEmitter)
 * @param {object} res Node response (writeHead/write/end)
 * @param {{heartbeatMs?: number, initialComment?: string, onClose?: (reason: string) => void}} [options]
 * @returns {{closed: boolean, heartbeat: NodeJS.Timeout|null, heartbeatMs: number,
 *   write: (chunk: string) => boolean, send: (event: string, data: unknown) => boolean,
 *   comment: (text: string) => boolean, close: (reason?: string) => void}}
 */
export function openSseChannel(req, res, options = {}) {
  const heartbeatMs = normalizeHeartbeatMs(options.heartbeatMs);
  const onClose = typeof options.onClose === "function" ? options.onClose : null;
  let heartbeat = null;
  let closed = false;
  let closeReason = null;
  let initialWriteFailed = false;

  if (res && !res.headersSent && typeof res.writeHead === "function") {
    res.writeHead(200, { ...SSE_HEADERS });
  }
  if (
    options.initialComment &&
    !safeWrite(res, `: ${sanitizeComment(options.initialComment)}\n\n`)
  ) {
    // The peer went away before the stream opened; finish cleanup below.
    initialWriteFailed = true;
  }

  const close = (reason = "server_close") => {
    if (closed) return;
    closed = true;
    closeReason = reason;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (req && typeof req.off === "function") req.off("close", onRequestClose);
    if (res && typeof res.off === "function") res.off("close", onResponseClose);
    if (onClose) {
      try {
        onClose(reason);
      } catch {
        // A teardown listener must never break the close path.
      }
    }
    if (res && typeof res.end === "function") {
      try {
        res.end();
      } catch {
        // Socket already gone; cleanup is still complete.
      }
    }
  };

  function onRequestClose() {
    close("request_close");
  }
  function onResponseClose() {
    close("response_close");
  }

  const handle = {
    get closed() {
      return closed;
    },
    get heartbeat() {
      return heartbeat;
    },
    get closeReason() {
      return closeReason;
    },
    heartbeatMs,
    write(chunk) {
      if (closed) return false;
      if (!safeWrite(res, chunk)) {
        close("write_error");
        return false;
      }
      return true;
    },
    send(event, data) {
      return handle.write(sseFrame(event, data));
    },
    comment(text) {
      return handle.write(`: ${sanitizeComment(text)}\n\n`);
    },
    close,
  };

  if (initialWriteFailed) {
    handle.close("write_error");
    return handle;
  }

  if (!closed) {
    heartbeat = setInterval(() => {
      handle.comment("heartbeat");
    }, heartbeatMs);
    // A browser tab left open forever must not pin the server process.
    if (typeof heartbeat.unref === "function") heartbeat.unref();
  }

  if (req && typeof req.on === "function") req.on("close", onRequestClose);
  if (res && typeof res.on === "function") res.on("close", onResponseClose);

  return handle;
}

function activeContext(registeredCtx, invocationCtx) {
  if (invocationCtx && typeof invocationCtx === "object") return invocationCtx;
  return registeredCtx && typeof registeredCtx === "object" ? registeredCtx : {};
}

/**
 * Resolve the durable SessionStore for this stream.
 *
 * The server publishes the shared store on its ctx (`attachSessionContext`
 * in the session lane), so the SSE handlers see exactly the sessions the
 * REST handlers created, including the store's in-process `liveIds`. A bare
 * registry still gets one store per home instead of an empty stream.
 */
export function resolveSessionStore(ctx = {}) {
  const direct = ctx?.sessionStore;
  if (direct && typeof direct.get === "function" && typeof direct.eventsFile === "function") {
    return direct;
  }
  const viaServer = ctx?.server?.sessionStore;
  if (viaServer && typeof viaServer.get === "function" && typeof viaServer.eventsFile === "function") {
    return viaServer;
  }
  return attachSessionContext(ctx && typeof ctx === "object" ? ctx : {});
}

/**
 * Replay then tail an append-only JSONL event log.
 *
 * One code path serves both phases: `start()` reads from byte offset 0 and
 * then polls, so an existing line is never sent twice. Reads are byte-based
 * (`fs.readSync` at `offset`), decoded with `StringDecoder` so a multi-byte
 * UTF-8 character split across reads stays intact, and split on newlines with
 * the trailing partial line buffered until its newline is written. A file
 * that shrinks (rotated/truncated) restarts from 0. Malformed lines are
 * counted and skipped; nothing is synthesized.
 *
 * @param {{file: string, send: (record: object) => unknown, pollMs?: number}} options
 */
export function createEventTail({ file, send, pollMs = DEFAULT_EVENT_POLL_MS }) {
  let offset = 0;
  let partial = "";
  let malformed = 0;
  let closed = false;
  let timer = null;
  let decoder = new StringDecoder("utf8");

  const emitLine = (line) => {
    const text = line.trim();
    if (!text) return;
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      malformed += 1;
      return;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      malformed += 1;
      return;
    }
    send(record);
  };

  const consume = (chunk) => {
    partial += chunk;
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      if (closed) return;
      emitLine(line);
    }
  };

  const readNew = () => {
    if (closed) return;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return; // The log may not exist yet; keep polling while connected.
    }
    if (!stat.isFile()) return;

    const size = stat.size;
    if (size < offset) {
      // Rotated or truncated: the byte cursor is past the new end, so replay.
      offset = 0;
      partial = "";
      decoder = new StringDecoder("utf8");
    }
    if (size === offset) return;

    let fd = null;
    try {
      fd = fs.openSync(file, "r");
      const buffer = Buffer.alloc(Math.min(EVENT_READ_CHUNK, size - offset));
      while (!closed && offset < size) {
        const want = Math.min(buffer.length, size - offset);
        const bytesRead = fs.readSync(fd, buffer, 0, want, offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
        consume(decoder.write(buffer.subarray(0, bytesRead)));
      }
    } catch {
      // A rotation/permission race heals on the next tick.
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Already closed by the OS.
        }
      }
    }
  };

  const stop = () => {
    if (closed) return;
    closed = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return {
    get closed() {
      return closed;
    },
    get offset() {
      return offset;
    },
    get partial() {
      return partial;
    },
    get malformed() {
      return malformed;
    },
    get timer() {
      return timer;
    },
    pollMs,
    poll: readNew,
    start() {
      if (closed) return;
      readNew();
      if (closed) return;
      timer = setInterval(readNew, pollMs);
      // An abandoned browser tab must not keep the server alive.
      if (typeof timer.unref === "function") timer.unref();
    },
    stop,
  };
}

/** Live rows from the host provider, else the durable store's live records. */
export async function resolveLiveSessions(ctx = {}) {
  const source = ctx.listSessions ?? ctx.sessions;
  if (source !== undefined && source !== null) {
    const value = typeof source === "function" ? await source() : source;
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.sessions)) return value.sessions;
    return [];
  }

  const store = ctx.sessionStore || ctx.server?.sessionStore;
  if (!store || typeof store.list !== "function" || typeof store.toLive !== "function") {
    return [];
  }
  try {
    return store.list({ includeStopped: false }).map((record) => store.toLive(record));
  } catch {
    return [];
  }
}

async function resolveNetwork(ctx = {}) {
  if (ctx.network === undefined || ctx.network === null) return null;
  const value = typeof ctx.network === "function" ? await ctx.network() : ctx.network;
  return value && typeof value === "object" ? value : null;
}

function streamResult(handle, extra = {}) {
  return { status: 200, sse: true, stream: handle, ...extra };
}

function makeLiveSessionsHandler(registeredCtx) {
  return async function liveSessionsHandler({ req, res, ctx } = {}) {
    const active = activeContext(registeredCtx, ctx);
    // Resolve data BEFORE headers so a failing provider can still produce a
    // normal error response instead of a half-open stream.
    const sessions = await resolveLiveSessions(active);
    const network = await resolveNetwork(active);
    const snapshot = network ? { sessions, network } : { sessions };

    // No initial comment: the official client's first frame must be the
    // `snapshot` event (use-live-sessions.ts ignores every other name).
    const handle = openSseChannel(req, res, { heartbeatMs: active.heartbeatMs });
    handle.send("snapshot", snapshot);
    return streamResult(handle);
  };
}

function makeGlobalEventsHandler(registeredCtx) {
  return function globalEventsHandler({ req, res, ctx } = {}) {
    const active = activeContext(registeredCtx, ctx);
    const handle = openSseChannel(req, res, {
      heartbeatMs: active.heartbeatMs,
      initialComment: "connected",
    });
    // Intentionally no `data:` frames: there is no event bridge yet, and
    // inventing credential/tool events would make the official UI lie.
    return streamResult(handle);
  };
}

function makeSessionEventsHandler(registeredCtx) {
  return function sessionEventsHandler({ req, res, params, ctx } = {}) {
    const active = activeContext(registeredCtx, ctx);
    const session = typeof params?.session === "string" ? params.session.trim() : "";
    if (!session) {
      return {
        status: 400,
        body: { error: "session id is required", type: "invalid_request", session: null },
      };
    }

    // Resolve the durable record BEFORE opening the stream: an unknown id is
    // a real 404 the official client turns into "session gone", never a stream
    // that stays open forever pretending to be alive.
    const store = resolveSessionStore(active);
    const record = isSafeSessionId(session) ? store.get(session) : null;
    if (!record) {
      return {
        status: 404,
        body: {
          error: `Session '${session}' not found`,
          type: "unknown_session",
          session,
        },
      };
    }

    let tail = null;
    const handle = openSseChannel(req, res, {
      heartbeatMs: active.heartbeatMs,
      initialComment: `session ${session} connected`,
      // Every close path (request, response, write error, server close) stops
      // the file poller; the reverse is not needed because a closed channel
      // rejects further writes.
      onClose: () => tail?.stop(),
    });

    if (!handle.closed) {
      tail = createEventTail({
        file: store.eventsFile(session),
        send: (event) => handle.send("message", event),
        pollMs: normalizePollMs(active.eventPollMs),
      });
      tail.start();
    }
    handle.tail = tail;

    // Query params `types`/`watch` are accepted but not applied: the durable
    // log is the complete record, and the official client ignores event types
    // it does not render. Filtering would silently hide stored events.
    return streamResult(handle, { session_id: session });
  };
}

/**
 * Register the three official SSE routes on a RouteRegistry.
 *
 * Registered as `status: implemented` because the transport is real: correct
 * 200 text/event-stream headers, real frames from the durable session store,
 * heartbeat comments, and clean close. Route statuses are compatibility
 * statuses, so this behavior fix does not change any of them.
 *
 * @param {import("../router.js").RouteRegistry} registry
 * @param {object} [ctx] optional data/heartbeat context (see module docs)
 * @returns {import("../router.js").RouteRegistry}
 */
export function registerStreamRoutes(registry, ctx = {}) {
  if (!registry || typeof registry.register !== "function") {
    throw new TypeError("registerStreamRoutes(registry, ctx): registry.register is required");
  }

  registry.register("GET", STREAM_ROUTES.liveSessions, makeLiveSessionsHandler(ctx), {
    status: ROUTE_STATUS.IMPLEMENTED,
    official: true,
    transport: "sse",
    sseEvents: ["snapshot"],
    dataSource: "session_store",
    description: "Live session snapshot stream for the official frontend",
    notes:
      "SSE transport with an initial `snapshot` event of real LiveSession rows, heartbeat " +
      "comments, and clean close. Rows come from ctx.sessions/listSessions when the host " +
      "provides one, otherwise from the durable SessionStore's live records.",
  });

  registry.register("GET", STREAM_ROUTES.globalEvents, makeGlobalEventsHandler(ctx), {
    status: ROUTE_STATUS.IMPLEMENTED,
    official: true,
    transport: "sse",
    sseEvents: ["message"],
    dataSource: "empty",
    description: "Process-wide event stream for the official frontend",
    notes:
      "SSE transport is implemented (heartbeat comments, clean close) as an unnamed " +
      "`message` stream. No events are fabricated; credential/tool/CRM event " +
      "bridging is not implemented yet.",
  });

  registry.register("GET", STREAM_ROUTES.sessionEvents, makeSessionEventsHandler(ctx), {
    status: ROUTE_STATUS.IMPLEMENTED,
    official: true,
    transport: "sse",
    sseEvents: ["message"],
    dataSource: "session_store",
    description: "Per-session event stream for the official frontend",
    notes:
      "Replays every stored AgentEvent from sessions/<id>/events.jsonl as one unnamed " +
      "`event: message` frame, then tails appended lines (300ms poll, byte-offset cursor, " +
      "partial-line buffer). Unknown ids are a 404 unknown_session; malformed lines are " +
      "skipped. `types`/`watch` query filters are not applied (the stream is the full log).",
  });

  return registry;
}

/** Metadata shared by the official transports, useful to integration code. */
export const STREAM_ROUTE_META = Object.freeze({
  official: true,
  transport: "sse",
  dataSource: "session_store",
  note: STREAM_NOTE,
});

export default registerStreamRoutes;
