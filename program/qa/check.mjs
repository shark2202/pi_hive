import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const contractPath = path.join(root, "program", "contracts", "hive-api.json");
const dist = process.env.HIVE_FRONTEND_DIST || path.resolve(import.meta.dirname, "../../frontend/dist");
const base = process.env.PI_HIVE_BASE || "";
const failures = [];
const warnings = [];

function ok(name, condition, detail = "") {
  if (condition) console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  else { console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); failures.push(name); }
}

console.log("== contract ==");
if (!fs.existsSync(contractPath)) {
  warnings.push("contract missing; run the api-cartographer lane");
  console.log("SKIP contract missing");
} else {
  let contract;
  try { contract = JSON.parse(fs.readFileSync(contractPath, "utf8")); } catch (err) { failures.push("contract JSON"); console.log("FAIL contract JSON:", err.message); }
  if (contract) {
    const routes = Array.isArray(contract) ? contract : contract.routes;
    ok("contract routes array", Array.isArray(routes), Array.isArray(routes) ? `${routes.length} routes` : "not an array");
    if (Array.isArray(routes)) {
      const ids = new Set();
      let dup = 0, bad = 0;
      const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
      const statuses = new Set(["implemented", "partial", "shell-only", "missing"]);
      for (const r of routes) {
        if (ids.has(r.id)) dup += 1; ids.add(r.id);
        if (!r.method || !r.path || !r.client || !methods.has(String(r.method).toUpperCase()) || !statuses.has(r.pi_hive_status)) bad += 1;
      }
      ok("unique route ids", dup === 0, `${dup} duplicates`);
      ok("route fields valid", bad === 0, `${bad} invalid`);
      const counts = {};
      for (const r of routes) counts[r.pi_hive_status] = (counts[r.pi_hive_status] || 0) + 1;
      console.log("STATUS", JSON.stringify(counts));
      if ((counts.implemented || 0) > 0) {
        ok("some implemented", true, `${counts.implemented} official routes implemented`);
      } else {
        warnings.push("contract-freeze: no official frontend route is implemented yet");
        console.log("WARN no official route implemented yet (expected at contract freeze)");
      }
    }
  }
}

console.log("== official dist ==");
const indexPath = path.join(dist, "index.html");
ok("official dist index exists", fs.existsSync(indexPath), indexPath);
if (fs.existsSync(indexPath)) {
  const html = fs.readFileSync(indexPath, "utf8");
  ok("index references assets", html.includes("/assets/"));
  const asset = /\/assets\/[^"']+\.js/.exec(html)?.[0];
  ok("first JS asset present", asset ? fs.existsSync(path.join(dist, asset.replace(/^\//, ""))) : false, asset || "none");
}

if (base) {
  console.log("== served surface ==");
  const get = async (p) => {
    const res = await fetch(new URL(p, base));
    const text = await res.text();
    return { status: res.status, type: res.headers.get("content-type") || "", text };
  };
  try {
    const index = await get("/");
    ok("GET /", index.status === 200 && index.type.includes("text/html"), `${index.status} ${index.type}`);
    ok("GET / is official-ish", /<div id="root"|<script/i.test(index.text));
    const health = await get("/api/health");
    ok("GET /api/health", health.status === 200 && health.type.includes("application/json"), `${health.status} ${health.type}`);
    const routes = await get("/api/compat/routes");
    ok("GET /api/compat/routes", routes.status === 200, `${routes.status}`);
    const missing = await get("/api/__not_a_route__");
    ok("unknown /api is 501", missing.status === 501 && /not_implemented/.test(missing.text), `${missing.status}`);
    ok("unknown /api is JSON", missing.type.includes("application/json"), missing.type);
  } catch (err) {
    failures.push("served surface");
    console.log("FAIL served surface:", err.message);
  }
}

console.log("== summary ==");
console.log(`failures=${failures.length} warnings=${warnings.length}`);
if (warnings.length) console.log("warnings:", warnings.join("; "));
process.exitCode = failures.length ? 1 : 0;
