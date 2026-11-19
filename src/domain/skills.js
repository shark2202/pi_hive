import fs from "node:fs";
import path from "node:path";
import { colonyPaths } from "./colony.js";

function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2] };
}

export function listSkills(colonyName) {
  const root = colonyPaths(colonyName).skills;
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf8");
    const { meta, body } = parseFrontmatter(raw);
    out.push({ name: meta.name || entry.name, description: meta.description || "", body, path: file });
  }
  return out;
}

export function skillCatalog(colonyName) {
  const skills = listSkills(colonyName);
  if (!skills.length) return "(no colony skills yet)";
  return skills.map((s) => `- ${s.name}: ${s.description || "(no description)"}`).join("\n");
}

export function writeSkill(colonyName, { name, description = "", body }) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error("invalid skill name");
  const dir = path.join(colonyPaths(colonyName).skills, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
  return { name, description, path: file };
}

export function readSkill(colonyName, name) {
  return listSkills(colonyName).find((s) => s.name === name) || null;
}
