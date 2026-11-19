import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PI_HIVE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-mail-"));

const { QueenMail } = await import("../src/runtime/queen-mail.js");

test("queen mail routes letters and enforces depth", () => {
  const mail = new QueenMail({ maxDepth: 2, dailyLimit: 5 });
  const got = [];
  mail.register({ id: "a", name: "A", runtime: { injectLetter: () => {} } });
  mail.register({ id: "b", name: "B", runtime: { injectLetter: (...args) => got.push(args) } });
  assert.deepEqual(mail.list("a"), [{ id: "b", name: "B" }]);
  assert.deepEqual(mail.send({ from: "a", to: "b", text: "hello", depth: 1 }), { sent: true, to: "b", depth: 1 });
  assert.equal(got[0][0], "a");
  assert.equal(got[0][1], "A");
  assert.equal(got[0][2], "hello");
  assert.throws(() => mail.send({ from: "a", to: "b", text: "too deep", depth: 3 }), /max_depth/);
});
