/**
 * Contract self-check for program/contracts/hive-api.json.
 *
 * This validates the INVENTORY, not the runtime: it never starts pi_hive and
 * never calls an endpoint, so it passes regardless of how many routes are
 * implemented. The point is to keep the machine contract honest as routes are
 * added; runtime coverage is proven by the handler tests and the served-surface
 * checks in program/qa/check.mjs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANE_ROOT = path.resolve(HERE, "..", "..");
const CONTRACT_PATH = path.join(LANE_ROOT, "program", "contracts", "hive-api.json");

const STATUSES = ["implemented", "partial", "shell-only", "missing"];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const raw = fs.readFileSync(CONTRACT_PATH, "utf8");
const contract = JSON.parse(raw);

const routes = contract.routes;

test("top-level metadata is present and parseable", () => {
  assert.ok(contract.version, "version is required");
  assert.ok(contract.source, "source is required");
  assert.ok(contract.generated_at, "generated_at is required");
  assert.ok(contract.counts, "counts is required");
  assert.ok(
    !Number.isNaN(Date.parse(contract.generated_at)),
    `generated_at is not a date: ${contract.generated_at}`,
  );
  assert.equal(typeof contract.source.base, "string");
  assert.equal(contract.source.base, "/api");
  assert.ok(Array.isArray(contract.domains) && contract.domains.length > 0, "domains is required");
});

test("route count is positive and counts agree with the route array", () => {
  assert.ok(Array.isArray(routes), "routes must be an array");
  assert.ok(routes.length > 0, "contract must contain at least one route");
  assert.equal(contract.counts.total, routes.length, "counts.total must match routes.length");

  const sseCount = routes.filter((r) => r.sse === true).length;
  assert.equal(contract.counts.sse, sseCount, "counts.sse must match routes flagged sse");

  // The headline count is entries, not unique routes: state both explicitly.
  const http = routes.filter((r) => r.sse !== true);
  const uniqueHttp = new Set(http.map((r) => `${r.method} ${r.path}`));
  assert.equal(contract.counts.http, http.length, "counts.http must match non-SSE entries");
  assert.equal(
    contract.counts.unique_http,
    uniqueHttp.size,
    "counts.unique_http must match unique non-SSE method+path routes",
  );
  assert.equal(
    contract.counts.total,
    contract.counts.http + contract.counts.sse,
    "total must equal http + sse",
  );
  assert.equal(uniqueHttp.size, http.length, "duplicate HTTP method+path entries are not allowed");
  assert.equal(contract.counts.sse, 3, "the three official SSE endpoints must stay covered");

  const byStatus = {};
  for (const status of STATUSES) byStatus[status] = 0;
  for (const r of routes) byStatus[r.pi_hive_status] += 1;
  for (const status of STATUSES) {
    assert.equal(
      contract.counts.by_status[status],
      byStatus[status],
      `counts.by_status.${status} mismatch`,
    );
  }

  const byMethod = {};
  for (const r of routes) byMethod[r.method] = (byMethod[r.method] || 0) + 1;
  assert.deepEqual(contract.counts.by_method, byMethod, "counts.by_method mismatch");
});

test("route ids are unique and non-empty", () => {
  const seen = new Set();
  for (const r of routes) {
    assert.equal(typeof r.id, "string", "id must be a string");
    assert.ok(r.id.trim().length > 0, "id must not be empty");
    assert.ok(!seen.has(r.id), `duplicate route id: ${r.id}`);
    seen.add(r.id);
  }
});

test("every route has method, path, client and a valid status", () => {
  for (const r of routes) {
    assert.ok(METHODS.includes(r.method), `${r.id}: invalid method ${r.method}`);
    assert.equal(typeof r.client, "string", `${r.id}: client is required`);
    assert.ok(r.client.trim().length > 0, `${r.id}: client must not be empty`);
    assert.equal(typeof r.path, "string", `${r.id}: path is required`);
    assert.ok(r.path.startsWith("/"), `${r.id}: path must start with / (${r.path})`);
    assert.ok(!/\s/.test(r.path), `${r.id}: path must not contain whitespace`);
    assert.ok(!r.path.includes("${"), `${r.id}: path is not normalized`);
    assert.ok(!r.path.includes("encodeURIComponent"), `${r.id}: path still has encoding logic`);
    assert.ok(STATUSES.includes(r.pi_hive_status), `${r.id}: invalid status ${r.pi_hive_status}`);
    assert.equal(typeof r.sse, "boolean", `${r.id}: sse must be a boolean`);
    assert.ok(Array.isArray(r.sse_events), `${r.id}: sse_events must be an array`);
    for (const ev of r.sse_events) {
      assert.equal(typeof ev, "string", `${r.id}: sse event names must be strings`);
      assert.ok(ev.length > 0, `${r.id}: sse event names must not be empty`);
    }
    assert.equal(typeof r.notes, "string", `${r.id}: notes must be a string`);
    assert.ok("request_type" in r, `${r.id}: request_type key is required (may be null)`);
    assert.equal(typeof r.response_type, "string", `${r.id}: response_type is required`);
  }
});

test("SSE routes declare at least one event name", () => {
  for (const r of routes) {
    if (r.sse) {
      assert.ok(r.sse_events.length > 0, `${r.id}: SSE route must list its event names`);
    }
  }
});

test("the three official SSE endpoints stay covered by name", () => {
  const sse = routes
    .filter((r) => r.sse === true)
    .map((r) => `${r.method} ${r.path}`)
    .sort();
  assert.deepEqual(sse, [
    "GET /events/global",
    "GET /sessions/:session/events",
    "GET /sessions/live",
  ]);
});

test("dynamic segments are uniquely named within every path", () => {
  for (const r of routes) {
    const params = [...r.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    assert.equal(
      new Set(params).size,
      params.length,
      `${r.id}: repeated dynamic segment name in ${r.path} (${params.join(", ")})`,
    );
  }
});

test("every route exposes a machine-readable query array", () => {
  const types = new Set(["string", "integer", "boolean"]);
  for (const r of routes) {
    assert.ok(Array.isArray(r.query), `${r.id}: query must be an array`);
    const names = new Set();
    for (const q of r.query) {
      assert.equal(typeof q.name, "string", `${r.id}: query name must be a string`);
      assert.ok(q.name.trim().length > 0, `${r.id}: query name must not be empty`);
      assert.ok(!names.has(q.name), `${r.id}: duplicate query param ${q.name}`);
      names.add(q.name);
      assert.equal(typeof q.required, "boolean", `${r.id}.${q.name}: required must be a boolean`);
      assert.ok(types.has(q.type), `${r.id}.${q.name}: unsupported query type ${q.type}`);
      assert.ok(!r.path.includes(`:${q.name}`), `${r.id}: ${q.name} is a path param, not a query`);
    }
  }

  // The routes QA called out must carry their query parameters as data.
  const byId = new Map(routes.map((r) => [r.id, r]));
  assert.deepEqual(
    byId.get("memories.read").query.map((q) => [q.name, q.required]),
    [["path", true]],
  );
  assert.deepEqual(
    byId.get("colonyData.listRows").query.map((q) => q.name),
    ["limit", "offset", "order_by", "order_dir"],
  );
  assert.deepEqual(
    byId.get("globalData.listRows").query.map((q) => q.name),
    ["limit", "offset", "order_by", "order_dir"],
  );
  assert.deepEqual(
    byId.get("events.sessionStream").query.map((q) => q.name),
    ["types", "watch"],
  );
  assert.deepEqual(
    byId.get("sessions.eventsHistory").query.map((q) => q.name),
    ["limit", "before_offset", "before_index"],
  );
});

test("merged routes preserve every response variant", () => {
  const merged = routes.filter((r) => Array.isArray(r.variants));
  assert.equal(merged.length, 1, "only the worker-list route is merged today");
  const worker = merged[0];
  assert.equal(worker.method, "GET");
  assert.equal(worker.path, "/sessions/:session/workers");
  assert.equal(worker.variants.length, 2, "both caller shapes must survive the dedupe");
  const responseTypes = worker.variants.map((v) => v.response_type).sort();
  assert.deepEqual(responseTypes, ["{workers: LiveWorker[]}", "{workers: WorkerSummary[]}"]);
  for (const variant of worker.variants) {
    assert.equal(typeof variant.id, "string");
    assert.equal(typeof variant.response_type, "string");
    assert.equal(typeof variant.source, "string");
  }
  // Both callers must still be discoverable from the merged entry.
  assert.match(worker.source, /colonyWorkers\.ts/);
  assert.match(worker.source, /workers\.ts/);
});

test("no empty route families", () => {
  const families = new Set(routes.map((r) => r.domain));
  assert.ok(families.size > 0, "at least one domain is required");
  for (const domain of contract.domains) {
    assert.ok(families.has(domain), `declared domain has no routes: ${domain}`);
  }
  for (const domain of families) {
    assert.ok(contract.domains.includes(domain), `route domain not declared: ${domain}`);
    assert.equal(typeof domain, "string");
    assert.ok(domain.trim().length > 0, "domain must not be empty");
    assert.ok(
      contract.counts.by_domain[domain] > 0,
      `domain has no routes: ${domain}`,
    );
  }
  const sum = Object.values(contract.counts.by_domain).reduce((a, b) => a + b, 0);
  assert.equal(sum, routes.length, "by_domain counts must sum to the route count");
});

test("prints the contract counts", () => {
  const status = contract.counts.by_status;
  const domains = Object.entries(contract.counts.by_domain)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([d, n]) => `${d}=${n}`)
    .join(" ");
  console.log(
    `[hive-api contract] routes=${routes.length} sse=${contract.counts.sse} ` +
      `implemented=${status.implemented} partial=${status.partial} ` +
      `shell-only=${status["shell-only"]} missing=${status.missing}`,
  );
  console.log(`[hive-api contract] domains(${contract.domains.length}): ${domains}`);
  console.log(`[hive-api contract] file: ${CONTRACT_PATH}`);
  assert.ok(contract.counts.total > 0);
});
