import fs from "node:fs";
import { colonyPaths } from "../domain/colony.js";
import { listSkills } from "../domain/skills.js";
import { listTasks } from "../domain/plan.js";
import { openTracker } from "../domain/tracker.js";

const FOOTER = "Only act on this if relevant to the current work. NEVER mention this reminder to the user.";

export function wrapReminder(body) {
  return `<system-reminder>\n${String(body).trim()}\n\n${FOOTER}\n</system-reminder>`;
}

export class ReminderSource {
  constructor({ name, points = ["before_prompt", "idle_tick"] }) {
    this.name = name;
    this._points = new Set(points);
  }
  points() { return this._points; }
  async render(_ctx) { return null; }
}

export class TrackerSnapshotSource extends ReminderSource {
  constructor({ colony }) {
    super({ name: "tracker_snapshot", points: ["before_prompt"] });
    this.colony = colony;
  }
  async render() {
    const tracker = openTracker(this.colony);
    try {
      const tables = tracker.tableNames();
      if (!tables.length) return "The tracker has no tables yet. Create one with tracker_sql before fanning out.";
      const parts = [];
      for (const table of tables.slice(0, 8)) {
        const row = tracker.query(`SELECT COUNT(*) AS n FROM ${table}`)[0];
        parts.push(`${table}: ${row?.n ?? 0} rows`);
      }
      return `Tracker snapshot:\n${parts.map((p) => `- ${p}`).join("\n")}`;
    } finally {
      tracker.close();
    }
  }
}

export class ActiveWorkersSource extends ReminderSource {
  constructor({ queen }) {
    super({ name: "active_workers", points: ["before_prompt"] });
    this.queen = queen;
  }
  async render() {
    const workers = this.queen.workerManager.list();
    if (!workers.length) return null;
    return `Workers still running (${workers.length}):\n${workers.map((w) => `- ${w.id}: ${w.task}`).join("\n")}\nWait for their reports; do not dispatch the same work again.`;
  }
}

export class ColonyParallelSource extends ReminderSource {
  constructor({ colony, queen }) {
    super({ name: "colony_parallel", points: ["before_prompt", "idle_tick"] });
    this.colony = colony;
    this.queen = queen;
    this.lastNudgeAt = 0;
  }
  async render() {
    if (Date.now() - this.lastNudgeAt < 5 * 60 * 1000) return null;
    const skills = listSkills(this.colony);
    const playbooks = fs.existsSync(colonyPaths(this.colony).playbooks)
      ? fs.readdirSync(colonyPaths(this.colony).playbooks).filter((f) => f.endsWith(".play.js"))
      : [];
    if (skills.length && playbooks.length) return null;
    let completed = 0;
    const tracker = openTracker(this.colony);
    try {
      for (const table of tracker.tableNames()) {
        const cols = tracker.columns(table);
        if (!cols.includes("status")) continue;
        const row = tracker.query(`SELECT COUNT(*) AS n FROM ${table} WHERE status IN ('done','completed','success')`)[0];
        completed += Number(row?.n || 0);
      }
    } finally {
      tracker.close();
    }
    if (completed < 3) return null;
    this.lastNudgeAt = Date.now();
    return `You have completed at least ${completed} units. If the method is proven, write a skill (write_skill) and a JavaScript playbook (run_playbook), then converge the remaining rows instead of doing them inline.`;
  }
}

export class IdleSource extends ReminderSource {
  constructor({ queen, seconds = 120 }) {
    super({ name: "idle_nudge", points: ["idle_tick"] });
    this.queen = queen;
    this.seconds = seconds;
  }
  async render({ idleSeconds }) {
    if (idleSeconds < this.seconds) return null;
    const open = listTasks(this.queen.colony).filter((t) => !["completed", "archived"].includes(t.status));
    if (!open.length) return null;
    return `You have been idle for ${Math.round(idleSeconds)}s with open tasks: ${open.slice(0, 5).map((t) => t.subject).join(", ")}. Take the next concrete step. Do not ask the user unless genuinely blocked.`;
  }
}

export class ReminderHub {
  constructor({ queen, sources = [], intervalMs = 15000 }) {
    this.queen = queen;
    this.sources = sources;
    this.intervalMs = intervalMs;
    this.timer = null;
  }

  add(source) { this.sources.push(source); return this; }

  async collect(point, ctx = {}) {
    const out = [];
    for (const source of this.sources) {
      if (!source.points().has(point)) continue;
      try {
        const body = await source.render({ ...ctx, point });
        if (body && String(body).trim()) out.push({ source: source.name, body: String(body).trim() });
      } catch {
        // reminders are advisory; a broken source never breaks the loop
      }
    }
    return out;
  }

  async beforePrompt() {
    const items = await this.collect("before_prompt");
    return items.map((i) => wrapReminder(i.body)).join("\n\n");
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      if (this.queen.running || this.queen.queue.length) return;
      const idleSeconds = (Date.now() - this.queen.lastActivity) / 1000;
      const items = await this.collect("idle_tick", { idleSeconds });
      if (!items.length) return;
      this.queen.injectReminder(items.map((i) => i.body).join("\n\n"));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
