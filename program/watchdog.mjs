import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const statePath = path.join(root, "state.json");
const logPath = path.join(root, "watchdog.log");
const alertPath = path.join(root, "alerts.jsonl");
const intervalMs = Number(process.env.WATCHDOG_INTERVAL_MS || 30000);
const once = process.argv.includes("--once");
const alerted = new Map();

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`;
  fs.appendFileSync(logPath, text + "\n");
  console.log(text);
}

function notify(title, body) {
  const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
  execFile("osascript", ["-e", script], (err) => {
    if (err) log(`notification failed: ${err.message}`);
  });
}

function alert(key, title, body, cooldownMs = 10 * 60 * 1000) {
  const now = Date.now();
  if (now - (alerted.get(key) || 0) < cooldownMs) return;
  alerted.set(key, now);
  fs.appendFileSync(alertPath, JSON.stringify({ at: new Date().toISOString(), title, body }) + "\n");
  log(`ALERT ${title}: ${body}`);
  notify(title, body);
}

function readState() {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return null; }
}

function laneStatus(file) {
  const p = path.join(root, "..", file);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function check() {
  const state = readState();
  if (!state) return alert("state", "pi_hive watchdog", "program/state.json is missing or invalid");
  const now = Date.now();
  const remaining = state.deadline_epoch * 1000 - now;
  if (remaining < 0) alert("deadline", "pi_hive deadline missed", `Program deadline passed ${Math.round(-remaining / 60000)}m ago`);

  for (const [name, lane] of Object.entries(state.lanes)) {
    const status = laneStatus(lane.status_file);
    if (!status) {
      alert(`missing:${name}`, "pi_hive lane has no heartbeat", `${name} has not written LANE_STATUS.json`);
      continue;
    }
    const updated = new Date(status.updated_at || 0).getTime();
    const staleMs = now - updated;
    if (!Number.isFinite(updated) || staleMs > state.stale_minutes * 60 * 1000) {
      alert(`stale:${name}`, "pi_hive lane stalled", `${name} heartbeat is ${Math.round(staleMs / 60000)}m old`);
    }
    if (status.blocked) alert(`blocked:${name}`, "pi_hive lane blocked", `${name}: ${status.blocked}`);
  }
  log(`check ok remaining=${Math.round(remaining / 60000)}m`);
}

check();
if (!once) {
  setInterval(check, intervalMs);
}
