/**
 * Colony export/import as a single `.tar.gz`.
 *
 * A colony is a directory tree (metadata, tracker.sqlite, memory, skills, plan,
 * event logs), so the archive is a normal ustar tarball. Two rules make import
 * safe: every member path is refused if it is absolute or escapes the target,
 * and the target colony name is validated before anything is written.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { colonyDir, coloniesDir, ensureDir } from "../config.js";
import { loadMetadata } from "./colony.js";

const MAX_MEMBER_BYTES = 64 * 1024 * 1024;
const BLOCK = 512;

function header(name, size, mtimeSeconds, typeflag = "0", mode = 0o644) {
  const buf = Buffer.alloc(BLOCK, 0);
  buf.write(name.slice(0, 99), 0, "utf8");
  buf.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, "ascii");
  buf.write("0000000\0", 108, "ascii");
  buf.write("0000000\0", 116, "ascii");
  buf.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  buf.write(`${Math.floor(mtimeSeconds).toString(8).padStart(11, "0")}\0`, 136, "ascii");
  buf.write("        ", 148, "ascii");
  buf.write(typeflag, 156, "ascii");
  buf.write("ustar\0", 257, "ascii");
  buf.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return buf;
}

function walk(root, relative = "") {
  const out = [];
  const dir = path.join(root, relative);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    const full = path.join(root, rel);
    // Runtime sockets and lock files are not part of a colony's identity.
    if (entry.name.endsWith(".sock") || entry.name.endsWith(".lock") || entry.name === "node_modules") continue;
    if (entry.isDirectory()) {
      out.push({ name: `${rel}/`, type: "5" });
      out.push(...walk(root, rel));
    } else if (entry.isSymbolicLink()) {
      out.push({ name: rel, type: "2", linkname: fs.readlinkSync(full) });
    } else if (entry.isFile()) {
      out.push({ name: rel, type: "0", data: fs.readFileSync(full) });
    }
  }
  return out;
}

/** Pack one colony directory into a gzipped tar buffer. */
export function exportColony(colony) {
  const meta = loadMetadata(colony);
  if (!meta) throw new Error(`colony '${colony}' not found`);
  const root = colonyDir(colony);
  const entries = walk(root);
  const mtime = Math.floor(Date.now() / 1000);
  const chunks = [];
  for (const entry of entries) {
    if (entry.type === "0") {
      chunks.push(header(entry.name, entry.data.length, mtime), entry.data);
      const pad = (BLOCK - (entry.data.length % BLOCK)) % BLOCK;
      if (pad) chunks.push(Buffer.alloc(pad, 0));
    } else if (entry.type === "5") {
      chunks.push(header(entry.name, 0, mtime, "5", 0o755));
    } else if (entry.type === "2") {
      chunks.push(header(entry.name, 0, mtime, "2", 0o777));
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
}

/** Write the archive and report what it is, so a CLI can print the result. */
export function exportColonyToFile(colony, file) {
  const archive = exportColony(colony);
  const target = path.resolve(file);
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, archive);
  return { colony, path: target, size: archive.length, sha256: sha256(archive) };
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/** Read a ustar buffer into `{ name, type, data }` members, refusing unsafe paths. */
export function readTar(archive) {
  const members = [];
  let offset = 0;
  while (offset + BLOCK <= archive.length) {
    const block = archive.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const name = block.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(block.subarray(124, 136).toString("ascii").replace(/\0.*$/s, "").trim(), 8) || 0;
    const type = block.subarray(156, 157).toString("ascii") || "0";
    if (size > MAX_MEMBER_BYTES) throw new Error(`member '${name}' is too large`);
    if (isUnsafePath(name)) throw new Error(`refusing unsafe member path '${name}'`);
    const start = offset + BLOCK;
    const data = archive.subarray(start, start + size);
    members.push({ name, type, data });
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  return members;
}

function isUnsafePath(name) {
  if (!name || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return true;
  return name.split(/[\\/]/).includes("..");
}

const COLONY_NAME = /^[a-z0-9][a-z0-9-_]{0,63}$/;

/**
 * Restore a colony from an archive.
 *
 * @param {Buffer} archiveFile gzip or plain tar bytes
 * @param {{ name?: string, overwrite?: boolean }} options `name` renames the colony
 *        at import time; it defaults to the directory the members live under.
 */
export function importColony(archiveFile, { name = null, overwrite = false } = {}) {
  const raw = archiveFile[0] === 0x1f && archiveFile[1] === 0x8b ? zlib.gunzipSync(archiveFile) : archiveFile;
  const members = readTar(raw);
  if (members.length === 0) throw new Error("the archive has no members");

  // Members are relative to the colony root (export writes from there).
  const hasMetadata = members.some((member) => member.name === "metadata.json");
  const root = hasMetadata ? "" : `${members[0].name.split("/")[0]}/`;

  let target = name;
  if (!target) {
    const metaMember = members.find((member) => member.name === `${root}metadata.json`);
    if (!metaMember) throw new Error("the archive carries no metadata.json");
    try {
      target = String(JSON.parse(metaMember.data.toString("utf8")).id ?? "");
    } catch {
      throw new Error("the archive's metadata.json is not valid JSON");
    }
  }
  if (!COLONY_NAME.test(String(target))) throw new Error(`invalid colony name '${target}'`);
  if (loadMetadata(target) && !overwrite) {
    throw new Error(`colony '${target}' already exists; pass overwrite to replace it`);
  }

  const destination = colonyDir(target);
  fs.rmSync(destination, { recursive: true, force: true });
  ensureDir(destination);

  let files = 0;
  for (const member of members) {
    if (!member.name.startsWith(root)) continue;
    const relative = member.name.slice(root.length);
    if (!relative || relative.endsWith("/")) {
      if (relative) ensureDir(path.join(destination, relative));
      continue;
    }
    const targetPath = path.join(destination, relative);
    if (!targetPath.startsWith(destination + path.sep)) throw new Error(`refusing unsafe member path '${member.name}'`);
    ensureDir(path.dirname(targetPath));
    fs.writeFileSync(targetPath, member.data);
    files += 1;
  }
  return { colony: target, path: destination, files };
}

export { coloniesDir };
