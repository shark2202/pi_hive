import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { colonyPaths } from "./colony.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS playbook_runs (
  run_id TEXT PRIMARY KEY,
  name TEXT,
  status TEXT NOT NULL,
  dispatched INTEGER NOT NULL DEFAULT 0,
  dead_lettered INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  result_json TEXT,
  logs_json TEXT,
  created_at TEXT NOT NULL
);`;

export function openRunLog(colonyName) {
  const dbPath = path.join(colonyPaths(colonyName).dir, "colony.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  return {
    path: dbPath,
    record({ runId, name, status, dispatched = 0, deadLettered = 0, error = null, result = null, logs = [] }) {
      db.prepare(`INSERT OR REPLACE INTO playbook_runs
        (run_id, name, status, dispatched, dead_lettered, error, result_json, logs_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        runId,
        name || null,
        status,
        Number(dispatched) || 0,
        Number(deadLettered) || 0,
        error,
        result == null ? null : JSON.stringify(result),
        JSON.stringify(logs || []),
        new Date().toISOString(),
      );
    },
    list(limit = 20) {
      return db.prepare("SELECT * FROM playbook_runs ORDER BY created_at DESC LIMIT ?").all(Number(limit)).map((r) => ({
        ...r,
        result: r.result_json ? JSON.parse(r.result_json) : null,
        logs: r.logs_json ? JSON.parse(r.logs_json) : [],
      }));
    },
    close() {
      db.close();
    },
  };
}
