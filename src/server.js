import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";
import { PI_HIVE_VERSION, serverConfig } from "./config.js";
import { defaultRegistry, notImplementedBody, ROUTE_STATUS } from "./compat/router.js";
import { installCompatHandlers } from "./compat/install.js";
import { createColony, listColonies, loadMetadata, colonyPaths } from "./domain/colony.js";
import { getPlan } from "./domain/plan.js";
import { setSoulMode } from "./domain/soul.js";
import { openTracker } from "./domain/tracker.js";
import { createModelRuntime } from "./kernel/model.js";
import { messageText } from "./kernel/agent.js";
import { QueenRuntime } from "./runtime/queen.js";
import { QueenMail } from "./runtime/queen-mail.js";
import { Sentinel } from "./runtime/sentinel.js";
import { PlaybookRunner } from "./runtime/playbook.js";
import { TriggerManager } from "./runtime/triggers.js";
import { runWorker } from "./runtime/worker.js";

function json(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui");
export const DEFAULT_FRONTEND_DIST = path.resolve(import.meta.dirname, "../frontend/dist");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

const STATIC_PREFIXES = ["/assets/", "/logos/"];

function text(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function isStaticPath(pathname) {
  return (
    pathname === "/index.html" ||
    pathname === "/favicon.png" ||
    STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

/**
 * Resolve a request path inside the frontend dist, rejecting traversal and
 * anything outside the dist root. Encoded escapes are decoded before the
 * containment check; malformed escapes are rejected outright.
 */
export function resolveStaticPath(root, pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname.includes("\0")) {
    return null;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\") || !decoded.startsWith("/")) {
    return null;
  }
  // Reject traversal segments outright, even when normalization would keep
  // them inside the dist (e.g. /assets/../index.html).
  if (decoded.split("/").some((segment) => segment === "..")) return null;
  const normalized = path.posix.normalize(decoded);
  const allowed =
    normalized === "/index.html" ||
    normalized === "/favicon.png" ||
    STATIC_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  if (!allowed) return null;

  const absoluteRoot = path.resolve(root);
  const file = path.resolve(absoluteRoot, `.${normalized}`);
  const rel = path.relative(absoluteRoot, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return file;
}

function serveFile(req, res, file, cacheControl) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  res.writeHead(200, {
    "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
    "content-length": stat.size,
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  const stream = fs.createReadStream(file);
  stream.on("error", () => {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("failed to read file");
  });
  stream.pipe(res);
  return true;
}

function frontendUnavailable(req, res, pathname, dist) {
  const message = `Hive frontend build not found at ${dist}. Run "npm run ui:build" or set HIVE_FRONTEND_DIST.`;
  const wantsJson =
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/logos/") ||
    pathname === "/favicon.png" ||
    (req.headers.accept || "").includes("application/json");
  if (wantsJson) {
    return json(res, 503, { error: message, type: "frontend_unavailable", dist });
  }
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Hive frontend unavailable</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; line-height: 1.5">
<h1>Hive frontend build not found</h1>
<p>Expected the official frontend at <code>${dist.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</code>.</p>
<p>Run <code>npm run ui:install &amp;&amp; npm run ui:build</code> or start the server with <code>HIVE_FRONTEND_DIST=/path/to/dist</code>.</p>
</body></html>`;
  res.writeHead(503, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function serveUi(pathname, req, res) {
  const rel =
    pathname === "/" || pathname === "/ui" || pathname === "/ui/"
      ? "index.html"
      : pathname.replace(/^\/ui\//, "");
  const file = path.resolve(UI_DIR, rel);
  if (!file.startsWith(UI_DIR + path.sep) && file !== path.join(UI_DIR, "index.html")) {
    return text(res, 403, "forbidden");
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return text(res, 404, "not found");
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    "content-type": MIME[path.extname(file)] || "application/octet-stream",
    "content-length": body.length,
    "cache-control": "no-cache",
  });
  if (req.method === "HEAD") return res.end();
  res.end(body);
}

export class PiHiveServer {
  constructor(options = {}) {
    this.options = options;
    // Model runtime is created lazily: serving the compatibility shell and
    // static frontend must work without an LLM key configured.
    this._modelRuntime = options.modelRuntime || null;
    this.frontendDist = path.resolve(
      options.frontendDist || process.env.HIVE_FRONTEND_DIST || DEFAULT_FRONTEND_DIST,
    );
    this.runtimes = new Map();
    // Wire the official handler lanes onto the shared registry. ctx is this
    // server instance so handlers can read live colony runtimes.
    installCompatHandlers(this);
    this.queenMail = new QueenMail({ maxDepth: 8, dailyLimit: 100 });
    this.server = null;
  }

  get modelRuntime() {
    if (!this._modelRuntime) this._modelRuntime = createModelRuntime();
    return this._modelRuntime;
  }

  runtime(name) {
    if (this.runtimes.has(name)) return this.runtimes.get(name);
    const meta = loadMetadata(name);
    if (!meta) throw new Error(`colony '${name}' not found`);
    const queen = new QueenRuntime({
      colony: name,
      queenId: meta.queen_id || "queen_growth",
      queenName: meta.queen_name || meta.queen_id || "queen_growth",
      modelRuntime: this.modelRuntime,
      options: this.options,
    });
    queen.queenMail = this.queenMail;
    this.queenMail.register({ id: queen.queenId, name: queen.queenName, runtime: queen });
    queen.playbookRunner = new PlaybookRunner({ workerManager: queen.workerManager });
    queen.triggerManager = new TriggerManager({
      colony: name,
      onFire: (trigger, payload) => queen.injectTrigger(trigger, payload),
    });
    queen.triggerManager.start();
    if (meta.sentinel_enabled || process.env.PI_HIVE_SENTINEL === "1") {
      queen.sentinel = new Sentinel({ queen, colony: name, modelRuntime: this.modelRuntime });
      queen.sentinel.start();
    }
    queen.startReminders();
    this.runtimes.set(name, queen);
    return queen;
  }

  async handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" });
        return res.end();
      }
      if ((req.method === "GET" || req.method === "HEAD") && pathname === "/api/compat/routes") {
        return json(res, 200, {
          routes: defaultRegistry.list(),
          counts: defaultRegistry.counts(),
        });
      }
      if (
        (req.method === "GET" || req.method === "HEAD") &&
        (pathname === "/ui" || pathname === "/ui/" || pathname.startsWith("/ui/"))
      ) {
        return serveUi(pathname, req, res);
      }
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        // Official handlers and registered-but-missing routes answer before the
        // legacy dispatch: otherwise /api/colonies/tools-index would be
        // mistaken for a colony named "tools-index" and return 404, and the
        // official boot routes would never reach their handlers.
        const registered = defaultRegistry.match(req.method, pathname);
        if (registered && this.isDispatchable(registered.route)) {
          return await this.dispatchRegistered(registered, req, res);
        }
        return await this.handleApi(req, res, url, pathname);
      }
      if (req.method === "GET" || req.method === "HEAD") {
        return this.serveFrontend(req, res, pathname);
      }
      return json(res, 404, { error: `no route ${req.method} ${pathname}` });
    } catch (err) {
      if (!res.headersSent) return json(res, 500, { error: err.message, stack: err.stack });
      return res.end();
    }
  }

  /** Serve the official frontend dist, or a clear 503 when it is absent. */
  serveFrontend(req, res, pathname) {
    let distStat = null;
    try {
      distStat = fs.statSync(this.frontendDist);
    } catch {
      distStat = null;
    }
    if (!distStat || !distStat.isDirectory()) {
      return frontendUnavailable(req, res, pathname, this.frontendDist);
    }

    if (isStaticPath(pathname)) {
      const file = resolveStaticPath(this.frontendDist, pathname);
      if (!file) return text(res, 403, "forbidden");
      const cache = pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache";
      if (serveFile(req, res, file, cache)) return;
      return text(res, 404, "not found");
    }

    // SPA fallback for client-side routes.
    const indexFile = path.join(this.frontendDist, "index.html");
    if (!fs.existsSync(indexFile)) {
      return frontendUnavailable(req, res, pathname, this.frontendDist);
    }
    return serveFile(req, res, indexFile, "no-cache");
  }

  /**
   * Routes the compatibility dispatcher owns:
   *   - missing routes, answered with the structured 501;
   *   - official IMPLEMENTED *and* PARTIAL routes that have a real handler.
   *
   * Partial official handlers answer a documented 4xx (unsupported capability,
   * invalid input) instead of the generic 501, which is the whole point of the
   * compatibility shell. Native partial routes keep falling through to
   * handleApi: they are registered with a null handler (GET /api/colonies) so
   * the /ui/ dashboard contract does not change.
   */
  isDispatchable(route) {
    if (!route) return false;
    const status = route.meta?.status;
    if (status === ROUTE_STATUS.MISSING) return true;
    return (
      route.meta?.official === true &&
      typeof route.handler === "function" &&
      (status === ROUTE_STATUS.IMPLEMENTED || status === ROUTE_STATUS.PARTIAL)
    );
  }

  /** Run a registered handler and translate its descriptor into a response. */
  async dispatchRegistered(match, req, res) {
    const route = match.route;
    if (typeof route.handler === "function") {
      const result = await route.handler({
        req,
        res,
        route,
        params: match.params,
        pathname: match.pathname,
        // The server instance is the integration context (runtimes, options).
        ctx: this,
      });
      if (res.headersSent) return;
      if (result && typeof result.status === "number" && result.body !== undefined) {
        if (result.content_type || Buffer.isBuffer(result.body)) {
          // Raw-body routes (queen avatars): the handler owns the content type.
          res.writeHead(result.status, {
            "content-type": result.content_type || "application/octet-stream",
            ...(result.headers || {}),
          });
          return res.end(result.body);
        }
        return json(res, result.status, result.body);
      }
    }
    return json(
      res,
      501,
      notImplementedBody({ method: req.method, route: route.path }),
    );
  }

  /** Structured 501 for any /api route the legacy surface does not handle. */
  apiNotFound(req, res, pathname) {
    const match = defaultRegistry.match(req.method, pathname);
    if (match && this.isDispatchable(match.route)) {
      return this.dispatchRegistered(match, req, res);
    }
    return json(
      res,
      501,
      notImplementedBody({ method: req.method, route: pathname }),
    );
  }

  async handleApi(req, res, url, pathname) {
    try {
      if (req.method === "GET" && pathname === "/api/health") {
        return json(res, 200, { ok: true, service: "pi-hive", version: PI_HIVE_VERSION, pid: process.pid });
      }
      if (req.method === "GET" && pathname === "/api/colonies") {
        return json(res, 200, { colonies: listColonies() });
      }
      if (req.method === "POST" && pathname === "/api/colonies") {
        const body = await readBody(req);
        const meta = createColony({
          name: body.name,
          queenId: body.queen_id || "queen_growth",
          goal: body.goal || "",
          workerProfiles: body.worker_profiles || [],
          workspace: body.workspace || "",
          sentinelEnabled: Boolean(body.sentinel_enabled),
        });
        return json(res, 201, { colony: meta });
      }

      const colonyMatch = /^\/api\/colonies\/([^/]+)(?:\/(.*))?$/.exec(pathname);
      if (colonyMatch) {
        const name = decodeURIComponent(colonyMatch[1]);
        const rest = colonyMatch[2] || "";
        const meta = loadMetadata(name);
        if (!meta) return json(res, 404, { error: `colony '${name}' not found` });

        if (req.method === "GET" && rest === "") {
          return json(res, 200, { colony: meta, plan: getPlan(name), paths: colonyPaths(name) });
        }

        if (req.method === "GET" && rest === "messages") {
          const queen = this.runtime(name);
          const messages = (queen.agent?.state?.messages || [])
            .map((m) => ({ role: m.role, text: messageText(m) }))
            .filter((m) => m.text);
          return json(res, 200, { messages });
        }

        if (req.method === "GET" && rest === "tracker") {
          const sql = url.searchParams.get("sql") || "SELECT name FROM sqlite_master WHERE type='table'";
          const tracker = openTracker(name);
          try {
            return json(res, 200, { rows: tracker.query(sql) });
          } finally {
            tracker.close();
          }
        }

        if (req.method === "GET" && rest === "workers") {
          return json(res, 200, { workers: this.runtimes.get(name)?.workerManager.list() || [] });
        }

        if (req.method === "POST" && rest === "workers") {
          const body = await readBody(req);
          const report = await runWorker({
            colony: name,
            queenId: meta.queen_id || "queen_growth",
            modelRuntime: this.modelRuntime,
            task: body.task || "",
            data: body.data || {},
            profile: body.profile || "default",
            maxTurns: body.max_turns || this.options.maxWorkerTurns,
          });
          return json(res, 200, { report });
        }

        if (req.method === "POST" && rest === "chat") {
          const body = await readBody(req);
          const queen = this.runtime(name);
          if ((req.headers.accept || "").includes("text/event-stream")) {
            res.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
              connection: "keep-alive",
              "access-control-allow-origin": "*",
            });
            const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            const onDelta = (delta) => send("delta", { delta });
            queen.on("delta", onDelta);
            try {
              const result = await queen.chat(body.text || "");
              send("done", result);
            } catch (err) {
              send("error", { error: err.message });
            } finally {
              queen.off("delta", onDelta);
              res.end();
            }
            return;
          }
          const result = await queen.chat(body.text || "");
          return json(res, 200, result);
        }

        if (req.method === "GET" && rest === "events") {
          const queen = this.runtime(name);
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "access-control-allow-origin": "*",
          });
          const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          const onQueen = (event) => send("queen_event", event);
          const onWorker = (data) => send("worker_report", data);
          queen.on("queen_event", onQueen);
          queen.on("worker_report", onWorker);
          const ping = setInterval(() => res.write(": ping\n\n"), 15000);
          req.on("close", () => {
            clearInterval(ping);
            queen.off("queen_event", onQueen);
            queen.off("worker_report", onWorker);
          });
          return;
        }

        if (req.method === "GET" && rest === "soul") {
          const queen = this.runtime(name);
          return json(res, 200, queen.soul.status());
        }

        if (req.method === "POST" && rest === "soul/review") {
          const queen = this.runtime(name);
          try {
            return json(res, 200, await queen.soul.review());
          } catch (err) {
            return json(res, 500, { error: err.message });
          }
        }

        if (req.method === "POST" && rest === "soul/mode") {
          const body = await readBody(req);
          try {
            return json(res, 200, { soul: setSoulMode(name, body.mode) });
          } catch (err) {
            return json(res, 400, { error: err.message });
          }
        }

        if (req.method === "POST" && rest === "soul/apply") {
          const body = await readBody(req);
          const queen = this.runtime(name);
          try {
            return json(res, 200, { soul: queen.soul.apply(body.id) });
          } catch (err) {
            return json(res, 400, { error: err.message });
          }
        }

        if (req.method === "GET" && rest === "inbox") {
          const queen = this.runtime(name);
          return json(res, 200, { inbox: queen.sentinel?.inbox() || [] });
        }

        if (req.method === "POST" && rest === "sentinel/reply") {
          const body = await readBody(req);
          const queen = this.runtime(name);
          if (!queen.sentinel) return json(res, 400, { error: "sentinel is not enabled for this colony" });
          const result = await queen.sentinel.reply(body.text || "");
          return json(res, 200, result);
        }

        if (req.method === "POST" && rest === "playbooks/stop") {
          const body = await readBody(req);
          const queen = this.runtime(name);
          const status = queen.playbookRunner?.stop(body.run_id);
          if (!status) return json(res, 404, { error: `unknown run '${body.run_id}'` });
          return json(res, 200, status);
        }

        if (req.method === "POST" && rest === "playbooks/run") {
          const body = await readBody(req);
          const queen = this.runtime(name);
          const run = await queen.playbookRunner.start({ colony: name, ...body });
          return json(res, 202, run);
        }

        if (req.method === "GET" && rest === "playbooks/runs") {
          const queen = this.runtime(name);
          const runId = url.searchParams.get("run_id");
          if (runId) return json(res, 200, { run: queen.playbookRunner.status(runId) });
          return json(res, 200, { runs: [...queen.playbookRunner.runs.values()].map((s) => queen.playbookRunner.status(s.runId)) });
        }

        if (req.method === "GET" && rest === "triggers") {
          const queen = this.runtime(name);
          return json(res, 200, { triggers: queen.triggerManager.list() });
        }

        if (req.method === "POST" && rest === "triggers") {
          const body = await readBody(req);
          const queen = this.runtime(name);
          return json(res, 200, { trigger: queen.triggerManager.set({ ...body, colony: name }) });
        }

        const webhookMatch = /^triggers\/([^/]+)\/webhook$/.exec(rest);
        if (req.method === "POST" && webhookMatch) {
          const queen = this.runtime(name);
          const trigger = decodeURIComponent(webhookMatch[1]);
          const body = await readBody(req);
          queen.triggerManager.fire(trigger, { webhook: body });
          return json(res, 200, { ok: true, trigger });
        }

        return this.apiNotFound(req, res, pathname);
      }

      return this.apiNotFound(req, res, pathname);
    } catch (err) {
      return json(res, 500, { error: err.message, stack: err.stack });
    }
  }

  start() {
    const { host, port } = serverConfig();
    this.server = http.createServer((req, res) => this.handle(req, res));
    return new Promise((resolve) => {
      this.server.listen(port, host, () => {
        const addr = this.server.address();
        resolve({ host: addr.address, port: addr.port, url: `http://${addr.address}:${addr.port}` });
      });
    });
  }

  async stop() {
    for (const runtime of this.runtimes.values()) runtime.stop();
    this.runtimes.clear();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
  }
}

/**
 * Build a request handler around a private PiHiveServer instance. Used by
 * tests and embedders to run the shell on an ephemeral port.
 */
export function createHandler(options = {}) {
  const server = new PiHiveServer(options);
  const handler = (req, res) => server.handle(req, res);
  handler.server = server;
  return handler;
}

let sharedHandler = null;

/** Module-level handle bound to one lazily created default server. */
export async function handle(req, res) {
  if (!sharedHandler) sharedHandler = createHandler();
  return sharedHandler(req, res);
}
