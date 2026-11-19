import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { colonyPaths } from "../domain/colony.js";
import { openTracker } from "../domain/tracker.js";
import { openRunLog } from "../domain/runlog.js";

function safeName(name) {
  const safe = String(name || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return safe || "playbook";
}

function nowId() {
  return `pb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function maybeAwait(value) {
  return value && typeof value.then === "function" ? await value : value;
}

export class PlaybookRunner {
  constructor({ workerManager }) {
    this.workerManager = workerManager;
    this.runs = new Map();
  }

  async #load({ colony, name, script }) {
    const dir = colonyPaths(colony).playbooks;
    fs.mkdirSync(dir, { recursive: true });
    let file;
    if (name) {
      file = path.join(dir, `${safeName(name)}.play.js`);
      if (!fs.existsSync(file)) throw new Error(`playbook '${name}' not found in ${dir}`);
    } else if (script) {
      const tmp = path.join(dir, `.inline-${Date.now()}.play.js`);
      fs.writeFileSync(tmp, script);
      file = tmp;
    } else {
      throw new Error("provide name or script");
    }
    let mod;
    try {
      mod = await import(`${pathToFileURL(file).href}?v=${Date.now()}`);
    } finally {
      if (!name && file && !script) fs.rmSync(file, { force: true });
    }
    const meta = mod.meta;
    if (!meta || typeof meta !== "object" || !meta.name) throw new Error("playbook must export a meta object with a name");
    if (typeof mod.run !== "function") throw new Error("playbook must export async function run(ctx)");
    if (!name) {
      const target = path.join(dir, `${safeName(meta.name)}.play.js`);
      fs.renameSync(file, target);
      file = target;
    }
    return { meta, run: mod.run, file };
  }

  async start({ colony, name, script, args = {} }) {
    const loaded = await this.#load({ colony, name, script });
    const runId = nowId();
    const concurrency = Math.min(32, Math.max(1, Number(loaded.meta.concurrency || 8)));
    const state = {
      runId,
      name: loaded.meta.name,
      file: loaded.file,
      args: args || {},
      status: "running",
      stopped: false,
      dispatched: 0,
      deadletter: [],
      logs: [],
    };
    this.runs.set(runId, state);
    const tracker = openTracker(colony);
    const runlog = openRunLog(colony);

    const ctx = this.#context({ colony, tracker, state, concurrency });
    state.promise = (async () => {
      try {
        const result = await loaded.run(ctx);
        state.status = "done";
        state.result = result;
        runlog.record({
          runId,
          name: state.name,
          status: "done",
          dispatched: state.dispatched,
          deadLettered: state.deadletter.length,
          result,
          logs: state.logs,
        });
        return result;
      } catch (err) {
        state.status = "error";
        state.error = err.message;
        runlog.record({
          runId,
          name: state.name,
          status: "error",
          dispatched: state.dispatched,
          deadLettered: state.deadletter.length,
          error: err.stack || err.message,
          logs: state.logs,
        });
        throw err;
      } finally {
        tracker.close();
        runlog.close();
      }
    })();
    state.promise.catch(() => {});
    return { run_id: runId, name: state.name, status: "started", concurrency, path: loaded.file };
  }

  #context({ colony, tracker, state, concurrency }) {
    const runner = this;
    const lanes = new Map();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const lane = (name, { concurrency: c = 1, rate_per_min = null } = {}) => {
      const sem = { available: Math.max(1, Number(c) || 1), waiters: [] };
      const acquire = async () => {
        if (sem.available > 0) { sem.available -= 1; return; }
        await new Promise((resolve) => sem.waiters.push(resolve));
      };
      const release = () => {
        const next = sem.waiters.shift();
        if (next) next();
        else sem.available += 1;
      };
      const minInterval = rate_per_min && rate_per_min > 0 ? 60000 / rate_per_min : 0;
      lanes.set(name, { acquire, release, minInterval, nextAt: 0 });
      return { name, concurrency: c, rate_per_min };
    };

    const acquireLane = async (name) => {
      if (!name) return () => {};
      const gate = lanes.get(name);
      if (!gate) {
        state.logs.push(`warning: lane '${name}' not declared; dispatching unthrottled`);
        return () => {};
      }
      if (gate.minInterval > 0) {
        const now = Date.now();
        const start = Math.max(now, gate.nextAt);
        gate.nextAt = start + gate.minInterval;
        if (start > now) await sleep(start - now);
      }
      await gate.acquire();
      return () => gate.release();
    };

    const worker = async (task, opts = {}) => {
      const attempts = Math.max(1, Number(opts.retries || 0) + 1);
      let lastError = null;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (state.stopped) return { status: "failed", receipt: {}, attempts: attempt, error: "stopped" };
        const release = await acquireLane(opts.lane);
        state.dispatched += 1;
        let report = null;
        try {
          report = await runner.workerManager.spawnAndWait({
            task,
            data: opts.data || {},
            profile: opts.profile || "default",
            goal: opts.goal || "",
            schema: opts.schema,
            timeout: opts.timeout,
          });
        } catch (err) {
          lastError = err.message;
        } finally {
          release();
        }
        if (report && report.status === "success") {
          return { status: "done", receipt: report.data || {}, attempts: attempt, error: null };
        }
        lastError = report?.summary || lastError || "worker failed";
        if (attempt < attempts) {
          const backoff = opts.backoff;
          if (backoff === "exp") await sleep(Math.min(30000, 2 ** attempt * 1000));
          else if (backoff === "linear") await sleep(Math.min(30000, 1000 * attempt));
        }
      }
      return { status: "failed", receipt: {}, attempts, error: lastError };
    };

    const converge = async ({ pending, dispatch, maxRounds = 1, chunk = concurrency, circuitBreaker = null }) => {
      let rounds = 0;
      for (let r = 0; r < maxRounds; r++) {
        if (state.stopped) break;
        const rows = await maybeAwait(pending());
        if (!rows?.length) break;
        rounds += 1;
        let failed = 0;
        for (let i = 0; i < rows.length; i += chunk) {
          if (state.stopped) break;
          const slice = rows.slice(i, i + chunk);
          const results = await Promise.allSettled(slice.map((row, j) => dispatch(row, i + j)));
          for (const result of results) {
            if (result.status === "rejected") failed += 1;
            else if (result.value && result.value.status && result.value.status !== "done") failed += 1;
          }
        }
        state.logs.push(`round ${rounds}: ${rows.length} dispatched, ${rows.length - failed} ok, ${failed} failed`);
        if (circuitBreaker != null && rows.length && failed / rows.length > circuitBreaker) break;
      }
      const remaining = (await maybeAwait(pending())) || [];
      for (const row of remaining) state.deadletter.push({ row, reason: "unresolved" });
      return { rounds, converged: remaining.length === 0, remaining: remaining.length, dead_lettered: remaining.length };
    };
    return {
      colony,
      args: state.args || {},
      trackerQuery: (sql) => tracker.query(sql),
      trackerCount: (sql) => tracker.count(sql),
      trackerExec: (sql) => tracker.exec(sql),
      lane,
      worker,
      converge,
      log: (message) => state.logs.push(String(message)),
      deadletter: {
        list: () => [...state.deadletter],
        get size() { return state.deadletter.length; },
      },
      meta: { concurrency },
    };
  }

  status(runId) {
    const state = this.runs.get(runId);
    if (!state) return null;
    return {
      run_id: runId,
      name: state.name,
      status: state.status,
      stopped: state.stopped,
      dispatched: state.dispatched,
      dead_lettered: state.deadletter.length,
      logs: state.logs.slice(-20),
      error: state.error || null,
      result: state.result ?? null,
    };
  }

  stop(runId) {
    const state = this.runs.get(runId);
    if (!state) return null;
    state.stopped = true;
    if (state.status === "running") state.status = "stopping";
    return this.status(runId);
  }

  async wait(runId) {
    const state = this.runs.get(runId);
    if (!state) throw new Error(`unknown run '${runId}'`);
    return state.promise;
  }
}
