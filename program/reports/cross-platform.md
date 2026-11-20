# Cross-platform evidence

Date: 2026-11-20 (+08:00). Claim under test: the repo runs on macOS and Linux with no
machine-specific assumption, and the official frontend is served from inside the repo.

## Two real defects found and fixed

1. **The kernel dependencies were symlinks into the pi agent's global install.**
   `node_modules/@earendil-works/{pi-agent-core,pi-ai,pi-schema}` and `node_modules/typebox`
   were `-> <global-npm>/lib/node_modules/…` — a machine-specific assumption (and a hidden
   dependency on the host), so any fresh clone or Linux/Windows box would fail at import.
   All three packages are public on npm at exactly the declared `1.5.2`, so the fix was to
   materialize them: the four symlinks were removed and `npm install` wrote real copies plus
   a `package-lock.json` (43 KB). No version changed.
2. **Machine paths in tracked docs.** `docs/`, `program/`, `handoff.md` and `AGENTS.md`
   contained absolute home paths from earlier evidence runs. They were rewritten to
   `<hive-core>`, `<pi-hive>`, `<global-npm>` and `<home>` placeholders, so a repo-wide scan
   for the old prefix over `src tests frontend/src docs program README.md AGENTS.md
   handoff.md` returns nothing.

Two things that look like residue but are not: `node_modules/.bin/*` are npm's relative shims
(`../@earendil-works/pi-ai/dist/cli.js`), and this report names the old prefix while explaining
the fix — neither is a host assumption.

## macOS (host)

```
npm test                       # 239 tests, 239 pass, 0 fail
node program/qa/route-coverage.mjs   # 171/171 routes covered
PI_HIVE_BASE=http://127.0.0.1:8790 node program/qa/check.mjs  # failures=0 warnings=0
```

## Linux (`node:24-alpine`, Docker)

```
docker run --rm -v "$PWD":/w -v "$PWD/node_modules":/w/node_modules:ro -w /w \
  -e HOME=/tmp node:24-alpine node --test tests/*.test.js tests/compat/*.test.js
# ℹ tests 239 / pass 239 / fail 0
```

Server + frontend, inside the same container (`PI_HIVE_HOME=/tmp/hivehome`, port 8799):

```json
{"health":{"ok":true,"service":"pi-hive","version":"0.1.0","pid":14},
 "root_status":200,"has_frontend":true,"ui_status":200}
```

`/` served the built SPA (a real `index-*.js` asset reference) and `/ui/` the native
dashboard, so neither path needs `<hive-core>`.

## Windows

Not executed: no Windows host or CI runner is available in this environment, and a
`node:*-windowsservercore` container cannot be driven here. What the code does guarantee:

- no POSIX-only APIs in shipped code: paths go through `node:path`, and the one
  platform-conditional branch (`sessions.js` reveal) handles `win32` with `explorer`;
- file modes are best-effort (`chmod 0600` is skipped on `win32` in
  `config-store.js`/`credential-vault.js`), so a vault save cannot fail there;
- `PATHEXT` is honoured when resolving an MCP `stdio` command on `PATH`;
- tests use `os.tmpdir()` and `fs.realpathSync` rather than `/tmp` literals.

That is a code-level argument, not evidence. The row stays 🟡 in `docs/PARITY.md` until a
Windows runner exists.

## Reproduce

```bash
# host
npm test && node program/qa/route-coverage.mjs

# linux
docker run --rm -v "$PWD":/w -v "$PWD/node_modules":/w/node_modules:ro -w /w \
  -e HOME=/tmp node:24-alpine node --test tests/*.test.js tests/compat/*.test.js
```
