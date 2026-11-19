import fs from "node:fs";
import path from "node:path";
import { colonyPaths } from "./colony.js";
import { ensureDir, hiveHome } from "../config.js";

function memoryRoot(colonyName, scope, queenId = "queen") {
  if (scope === "global") return path.join(hiveHome(), "memory", "global");
  if (scope === "queen") return path.join(hiveHome(), "memory", "queens", queenId);
  if (scope === "colony") return path.join(colonyPaths(colonyName).dir, "memory");
  throw new Error(`unknown memory scope: ${scope}`);
}

export function readMemory(colonyName, scope = "global", queenId = "queen") {
  const root = memoryRoot(colonyName, scope, queenId);
  if (!fs.existsSync(root)) return "";
  const parts = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const text = fs.readFileSync(path.join(root, entry.name), "utf8").trim();
    parts.push(`## ${entry.name}\n${text}`);
  }
  return parts.join("\n\n");
}

export function writeMemory(colonyName, scope, filename, content, queenId = "queen") {
  if (!/^[A-Za-z0-9_-]+\.md$/.test(filename)) throw new Error("memory filename must be a simple .md name");
  const root = ensureDir(memoryRoot(colonyName, scope, queenId));
  const file = path.join(root, filename);
  fs.writeFileSync(file, content);
  return file;
}

export function searchMemory(colonyName, query, queenId = "queen") {
  const q = query.toLowerCase();
  const hits = [];
  for (const scope of ["global", "queen", "colony"]) {
    const text = readMemory(colonyName, scope, queenId);
    if (!text) continue;
    for (const block of text.split(/\n## /)) {
      if (block.toLowerCase().includes(q)) hits.push({ scope, text: block.slice(0, 2000) });
    }
  }
  return hits;
}
