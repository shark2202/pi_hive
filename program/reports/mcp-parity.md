# MCP parity — 7 routes implemented, loading still absent

Date: 2026-11-20 (+08:00). Domain: `mcp`.

## What changed

The seven MCP routes were `partial`: definitions were stored, but health answered
an explicit `400 integration_unavailable`. All seven are now real:

| Route | Behaviour |
|---|---|
| `GET /mcp/servers` | the stored definitions, `tool_count: null` until a probe has a real count |
| `POST /mcp/servers` | validated store: transport-specific required field (`command`/`url`/`socket_path`), name `1–64` chars of `[A-Za-z0-9._-]`, reserved `hive_`/`__hive` prefixes, `409 already_exists` on a duplicate name, `201` with the summary + hint |
| `DELETE /mcp/servers/:server` | removes a `local` entry; `400` for `built-in`, `404` for unknown |
| `POST .../enable`, `.../disable` | persists `enabled`; built-ins refused |
| `POST .../mode` | persists `tools`/`cli`; invalid mode `400`, built-ins refused |
| `POST .../health` | **real probe**, result persisted on the entry |

## The health probe (`probeTarget` in `src/compat/handlers/autonomy.js`)

| transport | probe |
|---|---|
| `stdio` | resolve the configured command on `PATH` (or as an absolute path) with `fs.accessSync(X_OK)`, honouring `PATHEXT` on Windows; missing → `unhealthy: command not found on PATH` |
| `http` / `sse` | `net.connect` to the URL's host/port, `tls.connect` for `https:`, 3 s timeout |
| `unix` | `net.connect({path})` to the configured socket |

The response is the official `McpHealthResult` (`name`, `status`, `tools`, `error`)
plus `detail`, `checked_at` and a `note` explaining the limit. `status` is
`healthy`/`unhealthy`, never a faked `healthy`; `tools` is always `0` because
pi_hive has no MCP client and a made-up count would be a lie. The probe outcome is
written back to `mcp_servers.json` as `last_health_status`, `last_error` and
`last_health_check_at`, which is what the panel's status chip reads after a refresh.

## Evidence

```
node --test tests/compat/autonomy-handlers.test.js   # 26 tests, 26 pass
npm test                                             # 232 tests, 232 pass
node /tmp/sync-contract.mjs   # changed=7 by_status={"implemented":146,"partial":25,...}
PI_HIVE_BASE=http://127.0.0.1:8790 node program/qa/check.mjs
  # STATUS {"implemented":146,"partial":25} … failures=0 warnings=0
```

Live HTTP on port 8790 (`PI_HIVE_HOME=$PWD/.tmp-home`):

- `POST /mcp/servers` `probe_ok` (stdio `node`) → `201`, summary with `tool_count: null`.
- `POST /mcp/servers/probe_ok/health` → `{status:"healthy", tools:0, error:null,
  detail:"command resolves to /usr/local/bin/node", note:"Reachability only: …"}`.
- `POST /mcp/servers` `probe_dead` (http `127.0.0.1:1`) → `201`;
  its health → `{status:"unhealthy", error:"ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:1"}`.
- re-adding `probe_ok` → `409`; `disable` → `{enabled:false}`;
  `mode cli` → `{mode:"cli"}`; list then showed
  `[('probe_ok', False, 'cli', 'healthy'), ('probe_dead', True, 'tools', 'unhealthy')]`
  — the probe results really are on the stored entries.
- `DELETE` both → `{removed:"probe_dead"}` / `{removed:"probe_ok"}`.

New tests assert the probe's honesty rather than a status code: a closed port is
`unhealthy` with a socket error, an absent binary is `unhealthy` with
`command not found on PATH`, a resolvable command is `healthy`, and the result
lands on the stored entry (`last_health_status`, `last_error`,
`last_health_check_at`).

## Not covered

- No MCP client: stored servers are never started, so no tool is ever offered to an
  agent and `health` cannot report a real `tools` count. That is tracked separately
  in `docs/PARITY.md` as `MCP tool loading ⬜`.
- The probe checks reachability, not MCP protocol conformance: a listening port that
  speaks something else still reads `healthy`.
- `env`/`headers` secrets stay in `mcp_servers.json` and are not echoed by any
  response (`mcpSummary` never includes `config`).
