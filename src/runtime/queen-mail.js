import fs from "node:fs";
import path from "node:path";
import { hiveHome } from "../config.js";

export class QueenMail {
  constructor({ maxDepth = 8, dailyLimit = 100 } = {}) {
    this.maxDepth = maxDepth;
    this.dailyLimit = dailyLimit;
    this.queens = new Map();
    this.sent = new Map();
    this.day = new Date().toISOString().slice(0, 10);
    this.logPath = path.join(hiveHome(), "queen-mail.jsonl");
  }

  register({ id, name, runtime }) {
    this.queens.set(id, { id, name: name || id, runtime });
  }

  list(fromId) {
    return [...this.queens.values()]
      .filter((q) => q.id !== fromId)
      .map(({ id, name }) => ({ id, name }));
  }

  #reserve(fromId) {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.sent.clear();
    }
    const count = this.sent.get(fromId) || 0;
    if (count >= this.dailyLimit) throw new Error(`daily_limit ${this.dailyLimit} reached`);
    this.sent.set(fromId, count + 1);
  }

  send({ from, to, text, depth = 0 }) {
    const target = this.queens.get(to);
    if (!target) throw new Error(`no queen '${to}' (use list_queens)`);
    if (depth > this.maxDepth) throw new Error(`max_depth ${this.maxDepth} reached`);
    this.#reserve(from);
    const fromQueen = this.queens.get(from);
    target.runtime.injectLetter(from, fromQueen?.name || from, text, depth);
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    fs.appendFileSync(this.logPath, JSON.stringify({
      at: new Date().toISOString(),
      from,
      to,
      depth,
      chars: String(text).length,
    }) + "\n");
    return { sent: true, to, depth };
  }
}
