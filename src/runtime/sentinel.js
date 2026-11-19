import fs from "node:fs";
import path from "node:path";
import { colonyPaths, loadMetadata } from "../domain/colony.js";
import { listTasks } from "../domain/plan.js";
import { createPiAgent, lastAssistantText } from "../kernel/agent.js";

const CLASSIFIER_SYSTEM = `You are Sentinel, the supervisor of a Hive colony queen.
The queen has paused before its goal is done. Decide:
- "continue": the pause is permission-seeking or a progress report while work still remains. The queen has standing authority to continue.
- "needs_human": a genuine blocker only a human can resolve (expired credentials, crashed tool, missing information, a real decision with materially different outcomes).
- "done": the goal is clearly complete and a final result was delivered.

If workers are still running, an idle queen is normally waiting for them: continue.
If the user's latest message asked the queen to stop/wait, answer needs_human.
Respond ONLY with JSON: {"verdict":"continue"|"needs_human"|"done","reason":"one short sentence"}.`;

export class Sentinel {
  constructor({
    queen,
    colony,
    modelRuntime,
    budgetSeconds = 300,
    maxNudges = 5,
    webhookUrl = process.env.PI_HIVE_SENTINEL_WEBHOOK || "",
    tickMs = 15000,
  }) {
    this.queen = queen;
    this.colony = colony;
    this.modelRuntime = modelRuntime;
    this.budgetSeconds = budgetSeconds;
    this.maxNudges = maxNudges;
    this.webhookUrl = webhookUrl;
    this.tickMs = tickMs;
    this.timer = null;
    this.nudges = 0;
    this.held = false;
    this.lastCheck = 0;
  }

  inboxPath() {
    return path.join(colonyPaths(this.colony).dir, "inbox.jsonl");
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.check().catch(() => {}), this.tickMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  reset() {
    this.nudges = 0;
    this.held = false;
  }

  async check() {
    if (this.held || this.queen.running || this.queen.queue.length) return null;
    const idle = (Date.now() - this.queen.lastActivity) / 1000;
    if (idle < this.budgetSeconds) return null;
    if (Date.now() - this.lastCheck < this.budgetSeconds) return null;
    this.lastCheck = Date.now();

    const meta = loadMetadata(this.colony) || {};
    const open = listTasks(this.colony).filter((t) => !["completed", "archived"].includes(t.status));
    const goal = meta.goal || "";
    if (!goal && !open.length) return null;

    const workers = this.queen.workerManager.list();
    const last = lastAssistantText(this.queen.agent.state.messages).slice(0, 1500);
    const verdict = await this.#classify({ goal, open, workers, last, idle });
    if (!verdict) return null;

    if (verdict.verdict === "continue") {
      this.nudges += 1;
      if (this.nudges > this.maxNudges) {
        await this.escalate("heartbeat", "queen has been nudged repeatedly");
        return "heartbeat";
      }
      this.queen.injectTrigger("sentinel_continue", { reason: verdict.reason, idle_seconds: Math.round(idle) });
      return "continue";
    }
    if (verdict.verdict === "needs_human") {
      await this.escalate("blocker", verdict.reason || "queen needs a human");
      this.held = true;
      return "needs_human";
    }
    if (verdict.verdict === "done") {
      await this.escalate("done", verdict.reason || "goal complete");
      this.held = true;
      return "done";
    }
    return null;
  }

  async #classify({ goal, open, workers, last, idle }) {
    const context = {
      goal,
      open_tasks: open.slice(0, 10).map((t) => `${t.id} [${t.status}] ${t.subject}`),
      running_workers: workers.map((w) => `${w.id}: ${w.task}`),
      idle_seconds: Math.round(idle),
      queen_last_message: last,
    };
    try {
      const agent = createPiAgent({
        systemPrompt: CLASSIFIER_SYSTEM,
        tools: [],
        modelRuntime: this.modelRuntime,
        maxTurns: 2,
      });
      await agent.prompt(JSON.stringify(context, null, 2));
      await agent.waitForIdle();
      const text = lastAssistantText(agent.state.messages);
      const match = /\{[\s\S]*\}/.exec(text);
      if (!match) return null;
      const parsed = JSON.parse(match[0]);
      if (!["continue", "needs_human", "done"].includes(parsed.verdict)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async escalate(kind, reason) {
    const record = {
      at: new Date().toISOString(),
      colony: this.colony,
      kind,
      reason,
      last_message: lastAssistantText(this.queen.agent.state.messages).slice(0, 2000),
    };
    fs.mkdirSync(path.dirname(this.inboxPath()), { recursive: true });
    fs.appendFileSync(this.inboxPath(), JSON.stringify(record) + "\n");
    this.queen.emit("sentinel_escalation", record);
    if (this.webhookUrl) {
      try {
        await fetch(this.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(record),
        });
      } catch {
        // channel failure is recorded only in the local inbox
      }
    }
    return record;
  }

  inbox() {
    if (!fs.existsSync(this.inboxPath())) return [];
    return fs.readFileSync(this.inboxPath(), "utf8").trim().split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return { raw: line }; }
    });
  }

  async reply(text) {
    this.reset();
    return this.queen.chat(`[SENTINEL REPLY]\n${text}`);
  }
}
