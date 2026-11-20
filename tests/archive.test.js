/**
 * Colony export/import round-trips, including the unsafe-archive refusals.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { colonyDir } from "../src/config.js";
import { createColony } from "../src/domain/colony.js";
import { exportColony, exportColonyToFile, importColony, readTar } from "../src/domain/archive.js";

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-archive-")));
process.env.PI_HIVE_HOME = HOME;

after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

function seed(name) {
  fs.rmSync(colonyDir(name), { recursive: true, force: true });
  createColony({ name, goal: "archive me" });
  const dir = colonyDir(name);
  fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
  fs.writeFileSync(path.join(dir, "memory", "notes.md"), "memory survives an export\n");
  fs.mkdirSync(path.join(dir, "skills", "demo"), { recursive: true });
  fs.writeFileSync(path.join(dir, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\nbody\n");
  // Runtime noise must not travel.
  fs.writeFileSync(path.join(dir, "live.sock"), "socket");
  fs.writeFileSync(path.join(dir, "tracker.lock"), "lock");
  return name;
}

test("an export is a real gzipped tar of the colony tree", () => {
  const name = seed("exp-one");
  const archive = exportColony(name);
  assert.equal(archive[0], 0x1f);
  assert.equal(archive[1], 0x8b);

  const members = readTar(zlib.gunzipSync(archive)).map((member) => member.name);
  assert.ok(members.includes("metadata.json"));
  assert.ok(members.includes("memory/notes.md"));
  assert.ok(members.includes("skills/demo/SKILL.md"));
  assert.equal(members.includes("live.sock"), false, "sockets are runtime noise");
  assert.equal(members.includes("tracker.lock"), false, "lock files are runtime noise");

  const result = exportColonyToFile(name, path.join(HOME, "exports", "exp-one.tar.gz"));
  assert.equal(result.size, fs.statSync(result.path).size);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});

test("an import restores the whole tree under the same name", () => {
  const name = seed("imp-one");
  const archive = exportColony(name);
  fs.rmSync(colonyDir(name), { recursive: true, force: true });

  const restored = importColony(archive);
  assert.equal(restored.colony, "imp-one");
  assert.ok(restored.files >= 3);
  assert.equal(fs.readFileSync(path.join(colonyDir(name), "memory", "notes.md"), "utf8"), "memory survives an export\n");
  assert.match(fs.readFileSync(path.join(colonyDir(name), "skills", "demo", "SKILL.md"), "utf8"), /name: demo/);
  assert.ok(fs.existsSync(path.join(colonyDir(name), "metadata.json")));
});

test("an import can rename the colony and refuses to clobber without overwrite", () => {
  const name = seed("imp-src");
  const archive = exportColony(name);

  const renamed = importColony(archive, { name: "imp-dst" });
  assert.equal(renamed.colony, "imp-dst");
  assert.equal(fs.readFileSync(path.join(colonyDir("imp-dst"), "memory", "notes.md"), "utf8"), "memory survives an export\n");

  assert.throws(() => importColony(archive), /already exists; pass overwrite/);
  const replaced = importColony(archive, { overwrite: true });
  assert.equal(replaced.colony, "imp-src");

  assert.throws(() => importColony(archive, { name: "../escape" }), /invalid colony name/);
  assert.throws(() => importColony(archive, { name: "UPPER" }), /invalid colony name/);
});

test("an archive member that escapes the colony is refused before anything is written", () => {
  // Hand-build a tar with a traversal member: the guard must reject it.
  const build = (memberName) => {
    const block = Buffer.alloc(512, 0);
    const data = Buffer.from("evil");
    block.write(memberName, 0, "utf8");
    block.write("0000644\0", 100, "ascii");
    block.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    block.write("0", 156, "ascii");
    block.write("ustar\0", 257, "ascii");
    block.write("00", 263, "ascii");
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    return Buffer.concat([block, data, Buffer.alloc(512 - (data.length % 512), 0), Buffer.alloc(1024, 0)]);
  };

  assert.throws(() => readTar(build("../escape.txt")), /refusing unsafe member path/);
  assert.throws(() => readTar(build("/etc/passwd")), /refusing unsafe member path/);

  const before = fs.existsSync(path.join(HOME, "escape.txt"));
  assert.throws(() => importColony(build("../escape.txt")), /refusing unsafe member path/);
  assert.equal(fs.existsSync(path.join(HOME, "escape.txt")), before, "no file may be written outside the colony");
});

test("an archive without metadata is refused instead of inventing a colony", () => {
  const empty = zlib.gzipSync(Buffer.alloc(1024, 0));
  assert.throws(() => importColony(empty), /no members/);
});
