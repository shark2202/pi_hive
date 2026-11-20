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
    /** Filled by start(): the missed fires this process reconciled. */
    this.missedFires = [];
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

  /**
   * Fires that were missed while the process was down.
   *
   * A trigger that was due N intervals ago fires **once** with
   * `{missed: true, missed_intervals: N}` — replaying every missed slot would
   * turn a long stop into a burst of runs. A trigger that has never fired is
   * armed from now instead of being treated as infinitely overdue.
   *
   * @returns {Array<{name: string, missed_intervals: number, last_fired_at: string|null}>}
   */
  reconcileMissed(now = new Date()) {
    const missed = [];
    for (const trigger of this.triggers) {
      if (!trigger.enabled) continue;
      if (!trigger.last_fired_at) {
        trigger.last_fired_at = now.toISOString();
        continue;
      }
      const last = new Date(trigger.last_fired_at).getTime();
      if (!Number.isFinite(last)) continue;
      let intervals = 0;
      if (trigger.type === "interval") {
        const size = Number(trigger.interval_minutes) * 60000;
        if (size > 0) intervals = Math.floor((now.getTime() - last) / size);
      } else if (trigger.type === "cron") {
        // A cron trigger missed a slot when the last fire is older than the
        // grace window; how many slots is not meaningful without a cron parser,
        // so the count stays 1 and the payload says so.
        intervals = now.getTime() - last >= 120000 ? 1 : 0;
      }
      if (intervals >= 1) {
        missed.push({ name: trigger.name, missed_intervals: intervals, last_fired_at: trigger.last_fired_at });
      }
    }
    if (missed.length) this.#save();
    return missed;
  }

  start(now = new Date()) {
    if (this.timer) return;
    // Reconcile before arming, so a stop shorter than one interval is a no-op
    // and a long stop produces exactly one run per trigger.
    this.missedFires = this.reconcileMissed(now);
    for (const missed of this.missedFires) {
      this.fire(missed.name, { at: now.toISOString(), missed: true, missed_intervals: missed.missed_intervals });
    }
    // The logical clock, not the wall clock: a reconciled fire counts as this
    // start's slot, so an immediate restart does not fire it again.
    for (const t of this.triggers) {
      if (!t.last_fired_at || this.missedFires.some((entry) => entry.name === t.name)) {
        t.last_fired_at = now.toISOString();
      }
    }
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
