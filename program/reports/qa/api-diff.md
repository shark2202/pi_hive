# API Contract Diff — Independent QA vs Cartographer

> Historical QA input: this diff was written against the pre-fix 172-entry
> contract. The merged contract is now 171 entries = 168 unique HTTP + 3 SSE
> after the duplicate/param/query fixes; see `program/contracts/hive-api.json`
> and `docs/API_COMPAT.md`. The coverage findings below remain the evidence.

**Inputs**

- Independent inventory: `contract-qa/program/reports/api-inventory-qa.json`
  (168 unique HTTP method+path routes; 3 SSE endpoints).
- Cartographer contract: `api-cartographer/program/contracts/hive-api.json`
  (172 entries; 3 marked `sse`).
- Comparison method: normalize `:param` and `{param}` to `{}`, strip query
  strings, compare `(method, path)` sets; then compare request/response types,
  SSE flags/events and `pi_hive_status`.

## Headline

| Measure | Independent (C1) | Cartographer | Delta |
|---|---|---|---|
| Total route entries | 168 HTTP + 3 SSE | 172 entries (169 HTTP + 3 SSE) | +1 duplicate HTTP entry |
| Unique HTTP method+path | 168 | 168 | **0** |
| SSE endpoints | 3 | 3 | **0** |
| Missing from cartographer | — | **0** | pass |
| Invented / not in frontend | — | **0** | pass |
| Method mismatches | — | **0** | pass |
| Status values | — | 172 × `missing` | consistent (see below) |

## Missing from the cartographer

**None.** Every one of the 168 independent HTTP routes and all 3 SSE endpoints
appear in the contract. Set difference `mine − cartographer` = ∅ (normalized).

## Extra / invented

**No invented HTTP routes.** The three non-matching entries are the three real
SSE endpoints, which the cartographer correctly flags `sse: true`:

- `GET /sessions/:id/events` — `sse_events: ["message"]`
- `GET /events/global` — `sse_events: ["message"]`
- `GET /sessions/live` — `sse_events: ["snapshot"]`

The `/sessions/live` name is correct: `use-live-sessions.ts` ignores any frame
whose event name is not `snapshot`.

**One duplicate entry:** `GET /sessions/:id/workers` appears twice
(`colonyWorkers.list` `{workers: WorkerSummary[]}` and `workers.listLive`
`{workers: LiveWorker[]}`). Both shapes are real (two modules call the same
route with narrowing types), but as route inventory it double-counts: 172
entries → 168 unique HTTP routes. The headline "Routes: 172" therefore
overstates unique routes by 4 when read alongside "SSE streams: 3".

## Status mismatches

None. Every entry is `missing`, and that is consistent with the stated
definition (official method+path, not capability parity). Verified read-only:

- `pi_hive/src/server.js` registers `/api/health`, `/api/colonies` (GET/POST)
  and colony-scoped `/api/colonies/:name/{messages,tracker,workers,chat,events,
  soul,soul/review,soul/mode,soul/apply,inbox,sentinel/reply,playbooks/*,triggers,webhook}`.
- None of those is an exact `(method, path)` match for a frontend route, so
  `missing` is correct for all 172. `implemented/partial/shell-only` = 0 is
  accurate, not lazy.

## Quality defects (non-blocking for coverage, worth fixing before codegen)

1. **Repeated `:id` for distinct segments.** The contract uses `:id` for every
   dynamic segment, e.g.
   - `/colonies/:id/data/tables/:id/rows` (colony + table)
   - `/queen/:id/skills/:id/body` (queen + skill)
   - `/sessions/:id/workers/:id/stop` (session + worker)
   - `/credentials/local/:id/:id` (credential + alias)
   - `/claude-code-queens/:id/conversations/:id` (queen + session)

   The MD notes the segments are distinct at runtime, but a router/codegen that
   keys on parameter name will overwrite the first value with the second. Use
   distinct names (`:colony`, `:table`, `:queen`, `:skill`, `:session`,
   `:worker`, `:alias`).

2. **Query parameters live only in prose.** Required/meaningful queries are in
   `notes` (`?path=` for `/memories/file`, `?since=` for both change feeds,
   `?purge=true`, `?fresh=1`, `limit/offset/order_by/order_dir`,
   `limit/before_offset/before_index`, `?types=&watch=`), with no machine field.
   A shell implementer consuming JSON will not see them. Add a `query` array
   (name, required, type) per route.

3. **One pagination note is missing.** `GET /global/data/tables/:id/rows` has no
   note for `limit/offset/order_by/order_dir`, although `globalData.listRows`
   always builds them; the colony equivalent documents them.

4. **Header counts conflate SSE with routes.** `docs/API_COMPAT.md` says
   "Routes: 172 ... SSE streams: 3" without stating that the 3 SSE entries are
   inside the 172 and that one HTTP entry is a duplicate. Report
   "169 HTTP entries (168 unique) + 3 SSE" or dedupe.

## Verdict

**needs-fix (minor).** Route/SSE coverage is complete and no route is invented
or mis-methoded — this is a strong contract. Fix the duplicate worker-list
entry/count, give dynamic segments distinct names, and expose query parameters
as structured data. None of these blocks using the contract as the shell lane's
work list today; they do block generating a correct router from it.

### Exact set-difference output

```
mine 168  cart 171 (unique method+path; cart entries 172 incl. 1 duplicate)
IN MINE, MISSING FROM CARTOGRAPHER: 0
IN CARTOGRAPHER, NOT IN MINE: 3
  GET /events/global          (real SSE)
  GET /sessions/live          (real SSE)
  GET /sessions/{}/events     (real SSE)
```
