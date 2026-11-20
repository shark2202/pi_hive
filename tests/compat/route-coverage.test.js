/**
 * The coverage gate: every official route must be named by at least one test.
 *
 * This can go red — that is the point. `program/qa/route-coverage.mjs` exits 1
 * when a route has no test that names its method and a matching path, and this
 * test asserts the exit code plus the counts, so a new contract route without a
 * test fails the suite instead of quietly lowering coverage.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPT = path.join(ROOT, "program", "qa", "route-coverage.mjs");

function runCoverage() {
  const result = spawnSync(process.execPath, [SCRIPT, "--json"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(typeof result.stdout, "string");
  return { status: result.status, summary: JSON.parse(result.stdout) };
}

test("every official route is covered by a test", () => {
  const { status, summary } = runCoverage();
  const uncovered = summary.routes.filter((route) => !route.covered).map((route) => `${route.method} ${route.path}`);
  assert.deepEqual(uncovered, [], "routes with no test naming them");
  assert.equal(status, 0, "the coverage script must exit 0");
  assert.equal(summary.total, 171);
  assert.equal(summary.covered, summary.total);
});

test("the coverage map agrees with the contract counts", () => {
  const contract = JSON.parse(fs.readFileSync(path.join(ROOT, "program", "contracts", "hive-api.json"), "utf8"));
  const { summary } = runCoverage();
  assert.equal(summary.total, contract.routes.length);
  assert.equal(contract.counts.by_status.implemented, contract.routes.length);
  assert.equal(contract.counts.by_status.partial, 0);
  assert.equal(contract.counts.by_status.missing, 0);
  // Every domain in the contract appears in the coverage map.
  for (const domain of new Set(contract.routes.map((route) => route.domain))) {
    assert.ok(summary.byDomain[domain], `domain '${domain}' missing from the coverage map`);
  }
});
