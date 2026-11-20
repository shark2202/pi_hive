import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { colonyPaths } from "../domain/colony.js";
import { observeTurn, turnSignature } from "../domain/loop-guard.js";
import { recordTurnUsage } from "../domain/metering.js";
import { openTracker } from "../domain/tracker.js";
import { lastAssistantText, createPiAgent } from "../kernel/agent.js";
import { planTools, trackerTools, workerReportTool } from "./tools.js";
import { memoryTools } from "./memory-tools.js";
import { fsTools } from "./fs-tools.js";
import { skillCatalog } from "../domain/skills.js";
import { queenDefaults } from "../config.js";

export class WorkerManager extends EventEmitter {
  constructor({ colony, queenId, modelRuntime, options = {} }) {
    super();
    this.colony = colony;
    this.queenId = queenId;
    this.modelRuntime = modelRuntime;
    this.options = { ...queenDefaults(), ...options };
    this.active = new Map();
    this.handles = new Map();
    // Live pi-agent instances, keyed by worker id. `stop()` aborts through
    // this map; entries are removed when the run settles.
    this.agents = new Map();
    this.queue = [];
    this.counter = 0;
  }

  spawn({ task, data = {}, profile = "default", goal = "", schema = null, timeout = 0 }) {
    const id = `worker_${Date.now().toString(36)}_${++this.counter}`;
    const handle = {
      id,
      task,
      data,
      profile,
      goal,
      schema,
      timeout,
      status: "queued",
      startedAt: 0,
      report: null,
      stopRequested: false,
      promise: null,
      resolve: null,
      reject: null,
    };
    handle.promise = new Promise((resolve, reject) => {
      handle.resolve = resolve;
      handle.reject = reject;
    });
    handle.promise.catch(() => {});
    this.handles.set(id, handle);
    this.queue.push(handle);
    this.#drain();
    return id;
  }

  spawnAndWait(args) {
    const id = this.spawn(args);
    const handle = this.handles.get(id);
    if (!handle) throw new Error(`worker '${id}' disappeared`);
    return handle.promise;
  }

  list() {
    return [...this.active.values()].map((h) => ({
      id: h.id,
      task: h.task,
      status: "running",
      goal: h.goal || "",
      started_at: h.startedAt || null,
    }));
  }

  /**
   * Force-stop one worker. Queued work is removed before it starts; active
   * work is aborted through the pi-agent instance registered by #run().
   * Returns `{stopped, worker_id, status?, reason?}` — never throws for an
   * unknown id, so HTTP handlers can map `reason` onto a response.
   */
  stop(id) {
    const handle = this.handles.get(id);
    if (!handle) return { stopped: false, worker_id: id, reason: "not_found" };

    const queueIndex = this.queue.indexOf(handle);
    if (queueIndex >= 0) {
      this.queue.splice(queueIndex, 1);
      handle.status = "stopped";
      handle.stopRequested = true;
      try {
        handle.reject(new Error("worker stopped before start"));
      } catch {
        // The promise is already settled or has no attached rejection path.
      }
      return { stopped: true, worker_id: id, status: "stopped", reason: "queued" };
    }

    if (this.active.has(id)) {
      handle.status = "stopped";
      handle.stopRequested = true;
      const agent = this.agents.get(id);
      if (agent && typeof agent.abort === "function") {
        try {
          agent.abort();
        } catch {
          // Aborting an already-idle agent is best-effort.
        }
      }
      return { stopped: true, worker_id: id, status: "stopped" };
    }

    return {
      stopped: false,
      worker_id: id,
      status: handle.status || "completed",
      reason: "already_terminated",
    };
  }

  /** Stop every queued and active worker. Returns the official stop-all shape. */
  stopAll() {
    const ids = [...this.active.keys(), ...this.queue.map((handle) => handle.id)];
    const stopped = [];
    const errors = [];
    for (const id of ids) {
      const result = this.stop(id);
      if (result.stopped) stopped.push(id);
      else if (result.reason) errors.push({ worker_id: id, error: result.reason });
    }
    return { stopped, stopped_count: stopped.length, errors: errors.length ? errors : null };
  }

  #drain() {
    const max = Number(this.options.maxConcurrentWorkers || 4);
    while (this.active.size < max && this.queue.length) {
      const handle = this.queue.shift();
      handle.status = "running";
      handle.startedAt = handle.startedAt || Date.now();
      this.active.set(handle.id, handle);
      this.#run(handle).finally(() => {
        this.active.delete(handle.id);
        this.agents.delete(handle.id);
        this.#drain();
      });
    }
  }

  async #run(handle) {
    this.emit("worker_start", { id: handle.id, task: handle.task });
    try {
      const report = await runWorker({
        colony: this.colony,
        queenId: this.queenId,
        modelRuntime: this.modelRuntime,
        task: handle.task,
        data: handle.data,
        profile: handle.profile,
        goal: handle.goal,
        schema: handle.schema,
        timeout: handle.timeout,
        maxTurns: this.options.maxWorkerTurns,
        onAgent: (agent) => this.agents.set(handle.id, agent),
        onEvent: (event) => this.emit("worker_event", { id: handle.id, event }),
      });
      handle.report = report;
      this.emit("worker_report", { id: handle.id, report });
      handle.resolve(report);
      return report;
    } catch (err) {
      const report = handle.stopRequested
        ? { status: "stopped", summary: "worker stopped by user", data: {}, at: new Date().toISOString() }
        : { status: "failed", summary: err.message, data: {}, at: new Date().toISOString() };
      handle.report = report;
      this.emit("worker_report", { id: handle.id, report });
      handle.reject(err);
      return report;
    }
  }
}

/** The one extra instruction a run gets when it never reported. */
export const GRACE_PROMPT =
  "You have not called report_to_parent yet. Call it now with what you actually finished " +
  "(status success/partial/failed), a concise summary, and the structured data you gathered.";

/**
 * Keep only the fields a resume needs, so a caller cannot inject arbitrary text
 * into the prompt. Returns null when there is nothing to resume from.
 */
export function normalizeResume(resume) {
  if (!resume || typeof resume !== "object" || Array.isArray(resume)) return null;
  const summary = typeof resume.summary === "string" ? resume.summary.slice(0, 2000) : "";
  const data = resume.data && typeof resume.data === "object" && !Array.isArray(resume.data) ? resume.data : {};
  const at = typeof resume.at === "string" ? resume.at : typeof resume.report?.at === "string" ? resume.report.at : null;
  if (!summary && Object.keys(data).length === 0) return null;
  return { summary, data, at };
}

/** The prompt block that tells a worker what an earlier report already did. */
export function resumePrompt(resumed) {
  if (!resumed) return null;
  return [
    "This run resumes an earlier report (do not redo what it already finished):",
    JSON.stringify(resumed.data ?? {}, null, 2),
    `Previous summary: ${resumed.summary ?? ""}`,
  ].join("\n");
}

export async function runWorker({
  colony,
  queenId,
  modelRuntime,
  task,
  data = {},
  profile = "default",
  resume = null,
  goal = "",
  schema = null,
  timeout = 0,
  maxTurns = 4,
  onEvent,
  onAgent,
}) {
  const tracker = openTracker(colony);
  let report = null;
  let graceUsed = false;
  // A resumed worker starts from the previous report instead of from nothing.
  const resumedFrom = normalizeResume(resume);
  const toolset = [
    ...trackerTools(tracker),
    ...planTools(colony),
    ...memoryTools({ colony, queenId, writable: false }),
    ...fsTools(colony),
    workerReportTool((r) => {
      report = r;
    }),
  ];

  const systemPrompt = `You are a focused worker agent in the Hive colony "${colony}".
You have ONE task. Stay strictly in scope. Do not ask questions; there is no live audience.
Use tracker_query for context and tracker_upsert to record structured results.
When done, call report_to_parent with status success/partial/failed, a concise summary, and structured data.
If you discover adjacent work, mention it in one sentence in your report; do not chase it.

Task:
${task}

${goal ? `Goal for the UI: ${goal}\n` : ""}Assigned data:
${JSON.stringify(data, null, 2)}

Profile: ${profile}
${resumePrompt(resumedFrom) ? `${resumePrompt(resumedFrom)}\n` : ""}
${schema ? `Receipt schema (report.data must conform):\n${JSON.stringify(schema, null, 2)}\n` : ""}${tracker.tableNames().length ? `Tracker tables: ${tracker.tableNames().join(", ")}` : "The tracker has no tables yet."}

Skills:
${skillCatalog(colony)}
`;

  const agent = createPiAgent({
    systemPrompt,
    tools: toolset,
    modelRuntime,
    maxTurns,
    onEvent: (event) => onEvent?.(event),
  });
  onAgent?.(agent);

  let timer = null;
  try {
    const run = (async () => {
      await agent.prompt("Begin your assigned task now.");
      await agent.waitForIdle();
    })();
    run.catch(() => {});
    const timeoutMs = Number(timeout) || 0;
    if (timeoutMs > 0) {
      await Promise.race([
        run,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            agent.abort();
            reject(new Error(`worker timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } else {
      await run;
    }
    // Grace: a run that never called report_to_parent gets one last turn to hand
    // over what it already did, instead of losing the work to a missing tool call.
    if (!report) {
      try {
        await agent.prompt(GRACE_PROMPT);
        await agent.waitForIdle();
        graceUsed = true;
      } catch {
        // A failed grace turn leaves the fallback report below in charge.
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    tracker.close();
  }

  // Metering and the stall guard read the transcript the run just produced.
  // This agent belongs to this run only, so its whole transcript is the turn's.
  const produced = agent.state.messages;
  recordTurnUsage(colony, produced);
  const guard = observeTurn(colony, { signature: turnSignature(produced) });

  const final = report || {
    status: "partial",
    summary: lastAssistantText(agent.state.messages).slice(0, 4000) || "worker ended without report_to_parent",
    data: {},
    at: new Date().toISOString(),
    ...(graceUsed ? { grace_turn: true } : {}),
    ...(resumedFrom ? { resumed_from: resumedFrom.at ?? null } : {}),
    ...(guard.stalled ? { guard: { kind: guard.kind, reason: guard.reason } } : {}),
  };

  const dir = colonyPaths(colony).workers;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}.json`), JSON.stringify({
    queen_id: queenId,
    task,
    data,
    profile,
    report: final,
  }, null, 2));

  return final;
}
