import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-fs-"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-ws-"));
process.env.PI_HIVE_HOME = home;

const { createColony } = await import("../src/domain/colony.js");
const { fsTools } = await import("../src/runtime/fs-tools.js");

test("fs tools stay inside the workspace", async () => {
  createColony({ name: "fs-colony", workspace });
  const tools = Object.fromEntries(fsTools("fs-colony").map((t) => [t.name, t]));
  const write = await tools.file_write.execute("1", { path: "notes/a.txt", content: "hello pi-hive\n" });
  assert.equal(write.isError, undefined);
  assert.ok(fs.existsSync(path.join(workspace, "notes/a.txt")));
  const read = await tools.file_read.execute("2", { path: "notes/a.txt" });
  assert.match(read.content[0].text, /hello pi-hive/);
  const search = await tools.file_search.execute("3", { query: "pi-hive" });
  assert.match(search.content[0].text, /notes\/a\.txt:1/);
  const term = await tools.terminal_exec.execute("4", { command: "printf terminal-ok" });
  assert.match(term.content[0].text, /terminal-ok/);
  const escape = await tools.file_read.execute("5", { path: "../../etc/passwd" });
  assert.equal(escape.isError, true);
});
