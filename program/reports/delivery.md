# Delivery verification — the objective's evidence, in one place

Date: 2026-11-20 (+08:00). Re-run as a single battery before claiming anything.

## 1. Contract counts — `program/contracts/hive-api.json`

```json
{"implemented":171,"partial":0,"shell-only":0,"missing":0}   total 171
```

Recounted from the live registry via `installCompatHandlers()` (`reg.routes`, not
`reg.list()`), so a route that is not truly implemented cannot be counted in.

## 2. QC — `PI_HIVE_BASE=http://127.0.0.1:8790 node program/qa/check.mjs`

```
STATUS {"implemented":171}
failures=0 warnings=0
```

## 3. Tests — three suites

```
node --test tests/*.test.js tests/compat/*.test.js   # 266 tests, 266 pass, 0 fail
node --test tests/compat-shell.test.js               #   9 tests,   9 pass, 0 fail
node program/qa/route-coverage.mjs                   # 171/171 routes covered
```

Test count (266 + 9) exceeds the route count (171), and every official route is named by at
least one test (`tests/compat/route-coverage.test.js` fails the suite if a route loses its
test). The assertions are semantic: response shapes, persisted state, side effects, refusal
reasons — not status codes alone (see `program/reports/*-parity.md`).

## 4. Official frontend, served from this repo

`frontend/` is a maintained fork (own `package.json`, `package-lock.json`, `src/`, built
`dist/`). `src/server.js` defaults to `../frontend/dist`; `program/qa/check.mjs` defaults to
the same. Verified on macOS and inside `node:24-alpine`:

```json
{"health":{"ok":true,"service":"pi-hive","version":"0.1.0","pid":14},
 "root_status":200,"has_frontend":true,"ui_status":200}
```

No runtime path references the read-only Hive checkout: a scan for the old home prefix over
`src tests frontend/src docs program README.md AGENTS.md handoff.md` returns 0 hits.

## 5. Cross-platform

| Platform | Evidence |
|---|---|
| macOS (host) | full battery above |
| Linux (`node:24-alpine`, Docker) | `node --test tests/*.test.js tests/compat/*.test.js` → 266/266, and the server boots serving `/` + `/ui/` |
| Windows | code-level only: `node:path` everywhere, `win32` branches for reveal and `PATHEXT`, `chmod` best-effort; **no runner available** |

The host-specific defects found and fixed: the kernel dependencies were symlinks into the
host's global npm install (now real registry copies + a committed lockfile), and tracked docs
carried absolute home paths (now placeholders). No tracked symlinks remain.

## 6. Docs

`docs/API_COMPAT.md` (171 implemented, per-domain notes and narrower semantics),
`docs/PARITY.md` (no ⬜ left: ✅ or an explicit ➖ for out-of-scope), and the per-domain
reports under `program/reports/` are in step with the code in this commit.

## Not proven here

The official desktop chat end-to-end screenshot needs a model API key, which this environment
does not have (`PI_HIVE_API_KEY` / `BROADTOKEN_API_KEY` unset) and which may not be borrowed
from the pi agent's configuration. Everything on this page was re-run without one.
