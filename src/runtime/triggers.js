import fs from "node:fs";
import { colonyPaths } from "../domain/colony.js";

function parseField(field, min, max) {
  const values = new Set();
  for (const part of String(field).split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron step: ${part}`);
    let start = min;
    let end = max;
    if (range !== "*") {
      const bits = range.split("-");
      start = Number(bits[0]);
      end = bits.length > 1 ? Number(bits[1]) : start;
      if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error(`invalid cron field: ${part}`);
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values;
}

export function parseCron(expr) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron must have 5 fields: minute hour day month weekday");
  const [minute, hour, day, month, weekday] = fields;
  return {
    minute: parseField(minute, 0, 59),
    hour: parseField(hour, 0, 23),
    day: parseField(day, 1, 31),
    month: parseField(month, 1, 12),
    weekday: new Set([...parseField(weekday, 0, 6)].flatMap((d) => (d === 7 ? [0] : [d]))),
  };
}

export function cronMatches(expr, date = new Date()) {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  return c.minute.has(date.getUTCMinutes()) &&
    c.hour.has(date.getUTCHours()) &&
    c.day.has(date.getUTCDate()) &&
    c.month.has(date.getUTCMonth() + 1) &&
    c.weekday.has(date.getUTCDay());
}

export class TriggerManager {
  constructor({ colony, onFire, tickMs = 15000 }) {
    this.colony = colony;
    this.onFire = onFire;
    this.tickMs = tickMs;
    this.timer = null;
    this.path = colonyPaths(colony).triggers;
    this.triggers = this.#load();
  }

  #load() {
    if (!fs.existsSync(this.path)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(this.path, "utf8"));
      return Array.isArray(data.triggers) ? data.triggers : [];
    } catch {
      return [];
    }
  }

  #save() {
    fs.writeFileSync(this.path, JSON.stringify({ triggers: this.triggers }, null, 2));
  }

  set({ name, type, interval_minutes, cron, prompt, enabled = true }) {
    if (!name || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error("invalid trigger name");
    if (!["interval", "cron"].includes(type)) throw new Error("trigger type must be interval or cron");
    if (type === "interval" && (!Number(interval_minutes) || Number(interval_minutes) <= 0)) throw new Error("interval_minutes must be positive");
    if (type === "cron") parseCron(cron);
    const now = new Date().toISOString();
    const next = {
      name,
      type,
      interval_minutes: type === "interval" ? Number(interval_minutes) : null,
      cron: type === "cron" ? String(cron) : null,
      prompt: prompt || `Trigger ${name} fired.`,
      enabled: Boolean(enabled),
      created_at: now,
      last_fired_at: null,
    };
    const i = this.triggers.findIndex((t) => t.name === name);
    if (i >= 0) this.triggers[i] = { ...this.triggers[i], ...next, created_at: this.triggers[i].created_at };
    else this.triggers.push(next);
    this.#save();
    return next;
  }

  list() {
    return [...this.triggers];
  }

  #due(trigger, now) {
    if (!trigger.enabled) return false;
    if (!trigger.last_fired_at) return false;
    const last = new Date(trigger.last_fired_at).getTime();
    if (trigger.type === "interval") {
      return now.getTime() - last >= Number(trigger.interval_minutes) * 60000;
    }
    if (trigger.type === "cron") {
      if (!cronMatches(trigger.cron, now)) return false;
      return now.getTime() - last >= 60000;
    }
    return false;
  }

  fire(name, payload = {}) {
    const trigger = this.triggers.find((t) => t.name === name);
    if (!trigger) throw new Error(`trigger '${name}' not found`);
    trigger.last_fired_at = new Date().toISOString();
    this.#save();
    this.onFire?.(name, { ...payload, prompt: trigger.prompt });
    return trigger;
  }

  start() {
    if (this.timer) return;
    const now = new Date().toISOString();
    for (const t of this.triggers) if (!t.last_fired_at) t.last_fired_at = now;
    this.#save();
    this.timer = setInterval(() => {
      const now = new Date();
      for (const t of this.triggers) {
        if (this.#due(t, now)) this.fire(t.name, { at: now.toISOString() });
      }
    }, this.tickMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
