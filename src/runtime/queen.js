import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { colonyPaths, loadMetadata, saveMetadata } from "../domain/colony.js";
import { openTracker } from "../domain/tracker.js";
import { getPlan, listTasks } from "../domain/plan.js";
import { readMemory } from "../domain/memory.js";
import { skillCatalog } from "../domain/skills.js";
import { loadSoul } from "../domain/soul.js";
import { createPiAgent, lastAssistantText } from "../kernel/agent.js";
import { planTools, skillTools, textResult, trackerTools, soulTools } from "./tools.js";
import { memoryTools } from "./memory-tools.js";
import { fsTools } from "./fs-tools.js";
import { ReminderHub, TrackerSnapshotSource, ActiveWorkersSource, ColonyParallelSource, IdleSource } from "./reminders.js";
import { WorkerManager } from "./worker.js";
import { SoulEngine } from "./soul.js";
import { queenDefaults } from "../config.js";

const QUEEN_PERSONA = {
  queen_growth: "You are the Growth Queen: acquisition, experiments, and market insight. You are direct, evidence-driven, and allergic to vague growth advice.",
  queen_tech: "You are the Technology Queen: engineering, architecture, and delivery. You are precise, skeptical of hand-waving, and prefer verifiable results.",
  queen_finance: "You are the Finance Queen: models, budgets, and fundraising. You are conservative with assumptions and explicit about risk.",
  queen_ops: "You are the Operations Queen: process, back-office, and execution discipline. You make work repeatable.",
};

export class QueenRuntime extends EventEmitter {
  constructor({ colony, queenId = "queen_growth", queenName = "", modelRuntime, options = {} }) {
    super();
    this.colony = colony;
    this.queenId = queenId;
    this.queenName = queenName || queenId;
    this.queenMail = null;
    this.currentMailDepth = 0;
    this.modelRuntime = modelRuntime;
    this.options = { ...queenDefaults(), ...options };
    this.tracker = openTracker(colony);
    this.workerManager = new WorkerManager({ colony, queenId, modelRuntime, options: this.options });
    this.soul = new SoulEngine({ queen: this, colony, modelRuntime });
    this.queue = [];
    this.running = false;
    this.lastActivity = Date.now();
    this.pendingReports = [];
    this.reminderTimer = null;
    this.reminderHub = null;
    this.playbookRunner = null;
    this.triggerManager = null;
    this.agent = null;
    this.#buildAgent();

    this.workerManager.on("worker_report", ({ id, report }) => {
      this.emit("worker_report", { id, report });
      this.injectReport(id, report);
    });
    this.workerManager.on("worker_event", ({ id, event }) => this.emit("worker_event", { id, event }));
  }

  #sessionPath() {
    return path.join(colonyPaths(this.colony).sessions, `queen_${this.queenId}.json`);
  }

  #loadMessages() {
    const p = this.#sessionPath();
    if (!fs.existsSync(p)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      return Array.isArray(data.messages) ? data.messages : [];
    } catch {
      return [];
    }
  }

  #saveMessages(messages) {
    fs.writeFileSync(this.#sessionPath(), JSON.stringify({
      queen_id: this.queenId,
      colony: this.colony,
      updated_at: new Date().toISOString(),
      messages,
    }, null, 2));
  }

  #buildAgent() {
    const systemPrompt = this.systemPrompt();
    this.agent = createPiAgent({
      systemPrompt,
      tools: this.tools(),
      modelRuntime: this.modelRuntime,
      maxTurns: this.options.maxQueenTurns,
      initialMessages: this.#loadMessages(),
      onEvent: (event) => {
        this.emit("queen_event", event);
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          this.emit("delta", event.assistantMessageEvent.delta);
        }
      },
    });
  }

  systemPrompt() {
    const meta = loadMetadata(this.colony) || {};
    const plan = getPlan(this.colony);
    const open = listTasks(this.colony).filter((t) => !["completed", "archived"].includes(t.status));
    const tables = this.tracker.tableNames();
    const memory = [readMemory(this.colony, "global"), readMemory(this.colony, "queen", this.queenId), readMemory(this.colony, "colony")]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 12000);
    const soul = loadSoul(this.colony);
    const soulLines = [];
    if (soul.identity.mission) soulLines.push(`Mission: ${soul.identity.mission}`);
    if (soul.identity.voice?.length) soulLines.push(`Voice:\n${soul.identity.voice.map((v) => `- ${v}`).join("\n")}`);
    if (soul.identity.principles?.length) soulLines.push(`Principles:\n${soul.identity.principles.map((p) => `- ${p}`).join("\n")}`);
    if (soul.probes?.length) soulLines.push(`Probes:\n${soul.probes.slice(-5).map((p) => `- ${p.text}`).join("\n")}`);
    const soulBlock = soulLines.length ? soulLines.join("\n") : "(not set; use soul_review to propose changes)";
    return `${QUEEN_PERSONA[this.queenId] || `You are the ${this.queenId} Queen for this colony.`}

You lead the colony "${this.colony}" and are the only interface to the user.
Your goal: ${meta.goal || plan.goal || "(not recorded)"}

Operating rules:
- Execute first, then systematize: do one pilot yourself, record it in the tracker, then write a skill and fan out workers.
- The tracker (SQLite) is the source of truth. Use tracker_query / tracker_upsert / tracker_sql.
- Spawn workers only for well-scoped, independent units. Workers have no memory and cannot ask questions.
- Worker reports arrive as [WORKER_REPORT] turns. Validate them against the tracker.
- When a decision belongs to the user, ask in chat and stop. Do not guess.
- Keep the plan current with task_create / task_update / task_list.
- Reuse skills; when a method works, write_skill.

Colony plan (${open.length} open):
${open.map((t) => `- ${t.id} [${t.status}] ${t.subject}`).join("\n") || "(empty)"}

Tracker tables:
${tables.join(", ") || "(none yet; create with tracker_sql)"}

Skills:
${skillCatalog(this.colony)}

Soul:
${soulBlock}

Memory:
${memory || "(none)"}
`;
  }

  tools() {
    const queen = this;
    const tools = [
      ...trackerTools(this.tracker),
      ...planTools(this.colony),
      ...skillTools(this.colony),
      ...memoryTools({ colony: this.colony, queenId: this.queenId, writable: true }),
      ...fsTools(this.colony),
      ...soulTools({ engine: () => this.soul }),
      {
        name: "spawn_worker",
        label: "Spawn worker",
        description: "Spawn one ephemeral worker for a well-scoped task. Returns immediately; the report arrives later as a [WORKER_REPORT] turn.",
        parameters: {
          type: "object",
          properties: {
            task: { type: "string" },
            data: { type: "object", additionalProperties: true },
            profile: { type: "string" },
            goal: { type: "string", description: "One sentence for the UI; not shown to the worker" },
          },
          required: ["task"],
          additionalProperties: false,
        },
        async execute(_id, params) {
          const id = queen.workerManager.spawn(params);
          return textResult({ worker_id: id, status: "spawned" }, { worker_id: id });
        },
      },
      {
        name: "run_playbook",
        label: "Run playbook",
        description: "Run a saved JavaScript playbook over the tracker, or an inline playbook script. Returns a run id.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            script: { type: "string" },
            args: { type: "object", additionalProperties: true },
          },
          additionalProperties: false,
        },
        async execute(_id, params) {
          if (!queen.playbookRunner) return textResult({ error: "playbook runner not configured" });
          try {
            const run = await queen.playbookRunner.start({ colony: queen.colony, ...params });
            return textResult(run);
          } catch (err) {
            return textResult({ error: err.message });
          }
        },
      },
      {
        name: "set_trigger",
        label: "Set trigger",
        description: "Create or replace a timer trigger for this colony. Types: interval (minutes) or cron (5-field).",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: { type: "string", enum: ["interval", "cron"] },
            interval_minutes: { type: "number" },
            cron: { type: "string" },
            prompt: { type: "string" },
            enabled: { type: "boolean" },
          },
          required: ["name", "type"],
          additionalProperties: false,
        },
        async execute(_id, params) {
          if (!queen.triggerManager) return textResult({ error: "trigger manager not configured" });
          return textResult(queen.triggerManager.set({ ...params, colony: queen.colony }));
        },
      },
    ];
    tools.push(
      {
        name: "list_queens",
        label: "List Queens",
        description: "List the other Queens you can write to (empty when Queen Mail is not configured).",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          if (!queen.queenMail) return textResult([]);
          return textResult(queen.queenMail.list(queen.queenId));
        },
      },
      {
        name: "message_queen",
        label: "Message Queen",
        description: "Send a letter to another Queen. The reply arrives later as a [LETTER] turn.",
        parameters: {
          type: "object",
          properties: { to: { type: "string" }, text: { type: "string" } },
          required: ["to", "text"],
          additionalProperties: false,
        },
        async execute(_id, params) {
          if (!queen.queenMail) return textResult({ error: "Queen Mail is not configured" });
          try {
            return textResult(queen.queenMail.send({
              from: queen.queenId,
              to: params.to,
              text: params.text,
              depth: (queen.currentMailDepth || 0) + 1,
            }));
          } catch (err) {
            return textResult({ error: err.message });
          }
        },
      },
    );
    return tools;
  }

  async chat(text) {
    this.queue.push({ kind: "user", text });
    return this.#drain();
  }

  injectReport(workerId, report) {
    this.pendingReports.push({ workerId, report });
    this.queue.push({
      kind: "report",
      text: `[WORKER_REPORT] ${workerId}\nstatus: ${report.status}\nsummary: ${report.summary}\ndata: ${JSON.stringify(report.data || {})}`,
    });
    this.#drain();
  }

  injectTrigger(name, payload = {}) {
    this.queue.push({
      kind: "trigger",
      text: `[TRIGGER] ${name}\n${JSON.stringify(payload, null, 2)}\n\nYou were woken by this trigger. Act on it; do not ask the user unless a decision is genuinely theirs.`,
    });
    this.#drain();
  }

  injectLetter(fromId, fromName, text, depth = 0) {
    this.currentMailDepth = depth;
    this.queue.push({
      kind: "letter",
      text: `[LETTER from ${fromName} (${fromId})]\n${text}\n\nReply with message_queen if a response is needed.`,
    });
    this.#drain();
  }

  injectReminder(text) {
    this.queue.push({ kind: "reminder", text: `[REMINDER]\n${text}` });
    this.#drain();
  }

  async #drain() {
    if (this.running) return { queued: this.queue.length };
    this.running = true;
    this.lastActivity = Date.now();
    try {
      while (this.queue.length) {
        const item = this.queue.shift();
        this.lastActivity = Date.now();
        const reminderBlock = this.reminderHub ? await this.reminderHub.beforePrompt() : "";
        const prompt = reminderBlock ? `${reminderBlock}\n\n${item.text}` : item.text;
        await this.agent.prompt(prompt);
        await this.agent.waitForIdle();
        this.#saveMessages(this.agent.state.messages);
        this.lastActivity = Date.now();
      }
    } catch (err) {
      this.emit("runtime_error", err);
    } finally {
      this.running = false;
    }
    this.emit("idle");
    return { ok: true, text: lastAssistantText(this.agent.state.messages) };
  }

  startReminders() {
    if (this.reminderHub) return;
    this.reminderHub = new ReminderHub({
      queen: this,
      sources: [
        new TrackerSnapshotSource({ colony: this.colony }),
        new ActiveWorkersSource({ queen: this }),
        new ColonyParallelSource({ colony: this.colony, queen: this }),
        new IdleSource({ queen: this, seconds: Number(this.options.idleNudgeSeconds || 120) }),
      ],
    });
    this.reminderHub.start();
  }

  startIdleReminder() {
    this.startReminders();
  }

  stop() {
    this.sentinel?.stop();
    this.agent?.abort();
    this.reminderHub?.stop();
    this.reminderHub = null;
    if (this.reminderTimer) clearInterval(this.reminderTimer);
    this.reminderTimer = null;
    this.triggerManager?.stop();
    this.tracker.close();
  }
}
