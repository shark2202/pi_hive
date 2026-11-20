# Data parity — 9 global-DB routes implemented

Date: 2026-11-20 (+08:00). Domain: `data` (the nine official `/global/data/*`
routes, previously empty envelopes plus an explicit 404).

## What runs now

`src/compat/handlers/global-data.js` serves the official global-data surface from
a real SQLite file, `hiveHome()/global-data/team.db` (opened through
`openTrackerAt()` in `src/domain/tracker.js`, the same wrapper the colony tracker
uses: WAL, SELECT-only `query()`, bound parameters).

| Route | Behaviour |
|---|---|
| `GET /global/data/tables` | live schema: columns (`pragma_table_info`), primary key, row count |
| `GET /global/data/tables/:table/rows` | paged rows, `limit ≤ 500`, `offset`, `order_by`/`order_dir`; `404 unknown_table` |
| `POST /global/data/tables/:table/rows` | true insert; pk minted (`<table>-<uuid>`) when absent; `409 {error:'conflict', pk}` on duplicates; `updated_at` stamped |
| `PATCH /global/data/tables/:table/rows` | pk-addressed update; all pk columns required; pk columns in `updates` → 400; returns `{updated}` |
| `DELETE /global/data/tables/:table/rows` | pk-addressed delete; returns `{deleted}` |
| `POST /global/data/tables/:table/query` | server-side filter (eq/ne/gt/gte/lt/lte/contains/starts_with/ends_with/is_empty/is_not_empty), `search`, `order_by`/`order_dir`, `limit`/`offset`, accurate `total` |
| `POST /global/data/tables/:table/group-counts` | distinct values with counts, highest first, under the same filter/search |
| `GET /global/data/changes` | no `since` = init call (cursor + coverage only); with `since` = rows from `_global_changes` grouped per table, `truncated` past 2000 |
| `GET /global/data/foreign-keys` | edges inferred from `<table>_id` columns that resolve to a real table's single-column pk |

`_global_changes` is pi_hive's own append-only log. Hive's cursor is a
max-`updated_at` stamp; ours is the last log id, which the client passes back
verbatim, so the poll loop is identical.

Helpers for rows/SQL bound-safety were shared instead of copied: `colonies-data.js`
now exports the row machinery it already had (`tableColumns`, `primaryKeyOf`,
`quoteIdent`, `cellToJson`, `rowsOrderClause`, …) and the global lane imports it.
The global stubs (and the `global_data_unavailable` code) were deleted from
`colonies-data.js`, which now owns the 10 colony routes only.

## Evidence

```
node --test tests/compat/global-data-handlers.test.js   # 11 tests, 11 pass
node --test tests/compat/colonies-data-handlers.test.js # 29 tests, 29 pass
npm test                                                # 231 tests, 231 pass
node /tmp/sync-contract.mjs       # changed=9 by_status={"implemented":139,"partial":32,...}
PI_HIVE_BASE=http://127.0.0.1:8790 node program/qa/check.mjs
  # STATUS {"implemented":139,"partial":32} … failures=0 warnings=0
```

Live HTTP against the running server (`PI_HIVE_HOME=$PWD/.tmp-home`, port 8790):

- `GET /tables` listed `interactions` and `leads` with real columns/`pk` flags.
- insert → `{inserted:1, pk:{lead_id:"leads-41f1a3e1-…"}}`; re-inserting `L1` → `409`.
- `GET /rows?limit=2&order_by=name&order_dir=desc` → `table/columns/primary_key/rows/total/limit/offset`.
- `POST /query` with `stage eq "new"` returned only the matching row.
- `group-counts` grouped by `stage` (`null` and `"new"` buckets, highest first).
- `PATCH` → `{updated:1}`; `DELETE` → `{deleted:1}`.
- `/changes` init → `cursor:"3"`, `covered:["interactions","leads"]`, `tables:{}`;
  `/changes?since=0` → the three logged rows; `/tables/ghosts/rows` → `404`.

Tests assert semantics, not statuses: minted vs supplied pk, the conflicting row
not being written, pk columns refused in `updates`, filter/search counts, group
ordering under a filter, init-vs-follow cursor behaviour, and the inferred edge —
each checked against rows read back out of the SQLite file.

## Not covered

- This is a local file, not Hive's cloud team DB: no cross-machine team sync, no
  `hive-backend /v1/global-db` proxy, no 401-when-signed-out behaviour.
- No schema migrations or DDL routes: the client reads and writes rows, so tables
  must be created out of band (`node:sqlite` or any SQLite client on the file).
- Delete is not logged in `_global_changes` (the official feed is insert/update
  only; `ChangedRow.op` has no delete member), so a deleted row disappears from
  `/rows` without a feed entry.
- Change rows are de-duplicated per `(table, pk, op)` within one poll, matching
  the official "distinct rows changed in the window" contract.
