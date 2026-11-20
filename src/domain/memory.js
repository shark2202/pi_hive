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

// --- recall ----------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "so", "to", "of", "in", "on",
  "at", "for", "with", "about", "as", "is", "are", "was", "were", "be", "been", "it", "its",
  "this", "that", "these", "those", "i", "we", "you", "they", "he", "she", "do", "does", "did",
  "can", "could", "should", "would", "will", "not", "no", "yes", "my", "our", "your", "how",
  "what", "when", "where", "which", "who", "why", "all", "any", "some", "from", "by", "me",
]);

/** Lowercase word tokens worth scoring, in the order they appear. */
function terms(text) {
  const out = [];
  for (const match of String(text).toLowerCase().matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)) {
    if (STOPWORDS.has(match[0])) continue;
    out.push(match[0]);
  }
  return out;
}

function blocksOf(text, scope) {
  const blocks = [];
  for (const chunk of String(text).split(/\n## /)) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    // readMemory labels each file as `## <filename>`, so the file's own `# Title`
    // is the human heading; fall back to the filename when there is no title.
    const [firstLine, ...rest] = trimmed.split("\n");
    const file = firstLine.replace(/^##\s*/, "");
    const titleIndex = rest.findIndex((line) => /^#\s+/.test(line));
    const heading = titleIndex >= 0 ? rest[titleIndex].replace(/^#\s*/, "").trim() : file;
    const body = (titleIndex >= 0 ? [...rest.slice(0, titleIndex), ...rest.slice(titleIndex + 1)] : rest).join("\n");
    blocks.push({ scope, heading, file, text: `${heading}\n${body}`.trim() });
  }
  return blocks;
}

/**
 * Pick the memory blocks that match `query`, best first.
 *
 * Scoring is deliberately simple and explainable: 3 points per query term in the
 * heading, 1 per term in the body, plus a small recency bonus for files whose name
 * carries a later date. A block with no matching term is never returned, so an
 * unrelated query yields an empty list instead of the whole memory.
 *
 * @returns {Array<{scope: string, heading: string, text: string, score: number, matched: string[]}>}
 */
export function recallMemory(colonyName, query, { queenId = "queen", limit = 5 } = {}) {
  const queryTerms = [...new Set(terms(query))];
  if (queryTerms.length === 0) return [];

  const scored = [];
  for (const scope of ["global", "queen", "colony"]) {
    const text = readMemory(colonyName, scope, queenId);
    if (!text) continue;
    for (const block of blocksOf(text, scope)) {
      const headingTerms = new Set(terms(block.heading));
      const bodyTerms = new Set(terms(block.text));
      let score = 0;
      const matched = [];
      for (const term of queryTerms) {
        if (headingTerms.has(term)) {
          score += 3;
          matched.push(term);
        } else if (bodyTerms.has(term)) {
          score += 1;
          matched.push(term);
        }
      }
      if (score === 0) continue;
      const dated = block.heading.match(/(20\d{2})[-_]?(\d{2})[-_]?(\d{2})/);
      if (dated) score += 0.5;
      scored.push({ ...block, score, matched });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || a.heading.localeCompare(b.heading))
    .slice(0, Math.max(1, limit));
}

/** The recall block a prompt can embed; empty string when nothing matches. */
export function recallForPrompt(colonyName, query, options = {}) {
  const hits = recallMemory(colonyName, query, options);
  if (hits.length === 0) return "";
  return hits.map((hit) => `### ${hit.scope}: ${hit.heading}\n${hit.text}`).join("\n\n");
}

// --- reflection ------------------------------------------------------------

const REFLECTION_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function reflectionStatePath(colonyName, queenId) {
  return path.join(memoryRoot(colonyName, "queen", queenId), ".reflection.json");
}

export function readReflectionState(colonyName, queenId = "queen") {
  try {
    return JSON.parse(fs.readFileSync(reflectionStatePath(colonyName, queenId), "utf8"));
  } catch {
    return { last_at: null, runs: 0 };
  }
}

/**
 * Consolidate the colony's memory notes into `reflection.md`.
 *
 * Deterministic on purpose: repeated headings merge, duplicate lines collapse and
 * the newest entries win, so the result is stable without a model call. A cooldown
 * (6 h by default) keeps a busy loop from rewriting the same digest every turn;
 * `force: true` overrides it for an explicit run.
 *
 * @returns {{ skipped: boolean, reason?: string, file?: string, sections?: number, lines?: number, at?: string }}
 */
export function reflectMemory(colonyName, { queenId = "queen", force = false, now = new Date(), cooldownMs = REFLECTION_COOLDOWN_MS } = {}) {
  const state = readReflectionState(colonyName, queenId);
  const last = state.last_at ? new Date(state.last_at).getTime() : 0;
  if (!force && last && now.getTime() - last < cooldownMs) {
    return { skipped: true, reason: "cooldown", next_at: new Date(last + cooldownMs).toISOString() };
  }

  const byHeading = new Map();
  let seenLines = 0;
  for (const scope of ["global", "queen", "colony"]) {
    const text = readMemory(colonyName, scope, queenId);
    for (const block of blocksOf(text, scope)) {
      const key = block.heading.trim().toLowerCase();
      const entry = byHeading.get(key) ?? { heading: block.heading, scope, lines: [] };
      for (const line of block.text.split("\n").slice(1)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        seenLines += 1;
        if (!entry.lines.includes(trimmed)) entry.lines.push(trimmed);
      }
      byHeading.set(key, entry);
    }
  }

  const sections = [...byHeading.values()].sort((a, b) => a.heading.localeCompare(b.heading));
  const lines = [
    "---",
    "name: reflection",
    "type: digest",
    `generated_at: ${now.toISOString()}`,
    "---",
    "",
    `# Reflection digest (${sections.length} sections)`,
    "",
  ];
  for (const section of sections) {
    lines.push(`## ${section.heading}`, `scope: ${section.scope}`, ...section.lines.map((line) => `- ${line}`), "");
  }

  const root = ensureDir(memoryRoot(colonyName, "queen", queenId));
  const file = path.join(root, "reflection.md");
  fs.writeFileSync(file, `${lines.join("\n").trim()}\n`, "utf8");
  fs.writeFileSync(
    reflectionStatePath(colonyName, queenId),
    `${JSON.stringify({ last_at: now.toISOString(), runs: (state.runs ?? 0) + 1 }, null, 2)}\n`,
    "utf8",
  );
  return {
    skipped: false,
    file,
    sections: sections.length,
    lines: lines.length,
    source_lines: seenLines,
    at: now.toISOString(),
  };
}
