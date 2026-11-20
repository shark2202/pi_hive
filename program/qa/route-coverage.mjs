#!/usr/bin/env node
/**
 * Per-route test coverage: every official route must be exercised by at least one
 * test that names its method and a concrete path matching its pattern.
 *
 * Usage:
 *   node program/qa/route-coverage.mjs           # summary, exit 1 when a route is uncovered
 *   node program/qa/route-coverage.mjs --list    # one line per route
 *   node program/qa/route-coverage.mjs --json    # machine-readable map
 *
 * Detection is deliberately literal: a test counts for a route when a test file
 * contains a `"/api/..."` string whose segments match the route pattern and the
 * route's method appears in the same file. That is a floor, not proof of semantic
 * coverage — `program/reports/route-coverage.md` records the judgement per domain.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CONTRACT = path.join(ROOT, "program", "contracts", "hive-api.json");
const TESTS_DIR = path.join(ROOT, "tests");

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const asList = args.has("--list");

function testFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (/\.(test|spec)\.(js|mjs|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** `/api/queen/:queen/avatar` -> segments where `:x` is a wildcard. */
function segmentsOf(routePath) {
  return routePath.split("/").filter(Boolean);
}

function matchesPath(routeSegments, candidateSegments) {
  if (routeSegments.length !== candidateSegments.length) return false;
  for (let i = 0; i < routeSegments.length; i += 1) {
    const want = routeSegments[i];
    const got = candidateSegments[i];
    if (want.startsWith(":")) {
      // A concrete segment or a template wildcard both satisfy a pattern param.
      if (!got) return false;
      continue;
    }
    if (want !== got) return false;
  }
  return true;
}

const METHOD_RE = /\b(GET|POST|PUT|PATCH|DELETE)\b/g;

/** Every `/api/...` literal in a file, with the methods named in that file. */
function literalsOf(source) {
  const literals = new Set();
  for (const match of source.matchAll(/["'`](\/api\/[^"'`\s]*)["'`]/g)) {
    // `${id}` in a template literal is just another wildcard segment.
    // Drop the query/hash: coverage is about the path, not the parameters.
    literals.add(match[1].replace(/\$\{[^}]*\}/g, ":p").split("?")[0].split("#")[0]);
  }
  const methods = new Set();
  for (const match of source.matchAll(METHOD_RE)) methods.add(match[1]);
  for (const match of source.matchAll(/method:\s*["']([A-Z]+)["']/g)) methods.add(match[1]);
  return { literals: [...literals], methods };
}

const contract = JSON.parse(fs.readFileSync(CONTRACT, "utf8"));
const files = testFiles(TESTS_DIR).map((file) => ({ file: path.relative(ROOT, file), ...literalsOf(fs.readFileSync(file, "utf8")) }));

const routes = contract.routes.map((route) => {
  const apiPath = `/api${route.path}`;
  const segments = segmentsOf(apiPath);
  const hits = [];
  for (const file of files) {
    if (!file.methods.has(route.method)) continue;
    if (file.literals.some((literal) => matchesPath(segments, segmentsOf(literal)))) hits.push(file.file);
  }
  return {
    id: route.id,
    method: route.method,
    path: route.path,
    domain: route.domain,
    status: route.pi_hive_status,
    covered: hits.length > 0,
    files: hits,
  };
});

const uncovered = routes.filter((route) => !route.covered);
const byDomain = {};
for (const route of routes) {
  const bucket = (byDomain[route.domain] ??= { total: 0, covered: 0 });
  bucket.total += 1;
  if (route.covered) bucket.covered += 1;
}

if (asJson) {
  console.log(JSON.stringify({ total: routes.length, covered: routes.length - uncovered.length, byDomain, routes }, null, 2));
} else if (asList) {
  for (const route of routes) {
    const mark = route.covered ? "ok  " : "MISS";
    console.log(`${mark} ${route.method.padEnd(6)} ${route.path.padEnd(58)} ${route.files[0] ?? ""}`);
  }
  console.log(`\ncovered ${routes.length - uncovered.length}/${routes.length}`);
} else {
  console.log(`routes: ${routes.length}  covered: ${routes.length - uncovered.length}  uncovered: ${uncovered.length}`);
  for (const [domain, bucket] of Object.entries(byDomain).sort()) {
    console.log(`  ${domain.padEnd(20)} ${bucket.covered}/${bucket.total}`);
  }
  if (uncovered.length) {
    console.log("\nuncovered routes:");
    for (const route of uncovered) console.log(`  ${route.method} ${route.path}  (${route.id})`);
  }
}

process.exit(uncovered.length === 0 ? 0 : 1);
