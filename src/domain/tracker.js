import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { colonyPaths } from "./colony.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function openTracker(colonyName) {
  const { tracker } = colonyPaths(colonyName);
  fs.mkdirSync(path.dirname(tracker), { recursive: true });
  const db = new DatabaseSync(tracker);
  db.exec("PRAGMA journal_mode = WAL");
  return {
    db,
    path: tracker,
    exec(sql) {
      db.exec(sql);
      return { ok: true };
    },
    query(sql, params = []) {
      const trimmed = String(sql).trim();
      if (!/^(select|with)\b/i.test(trimmed)) {
        throw new Error("tracker_query only accepts SELECT / WITH statements");
      }
      const stmt = db.prepare(trimmed);
      return stmt.all(...params);
    },
    run(sql, params = []) {
      const stmt = db.prepare(String(sql));
      return stmt.run(...params);
    },
    count(sql, params = []) {
      const rows = this.query(sql, params);
      return rows.length;
    },
    upsert(table, row, key = "id") {
      if (!IDENT.test(table)) throw new Error(`invalid table name: ${table}`);
      const cols = Object.keys(row);
      if (cols.length === 0) throw new Error("row must have at least one column");
      for (const c of cols) if (!IDENT.test(c)) throw new Error(`invalid column name: ${c}`);
      if (!cols.includes(key)) throw new Error(`row must include key column '${key}'`);
      const placeholders = cols.map(() => "?").join(", ");
      const updates = cols.filter((c) => c !== key).map((c) => `${c} = excluded.${c}`).join(", ");
      const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})` +
        (updates ? ` ON CONFLICT(${key}) DO UPDATE SET ${updates}` : ` ON CONFLICT(${key}) DO NOTHING`);
      return this.run(sql, cols.map((c) => row[c]));
    },
    tableNames() {
      return this.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r) => r.name);
    },
    columns(table) {
      if (!IDENT.test(table)) throw new Error(`invalid table name: ${table}`);
      return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
    },
    close() {
      db.close();
    },
  };
}
