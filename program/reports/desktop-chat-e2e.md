# Desktop chat end-to-end — what was proven, what is still blocked

Date: 2026-11-20 (+08:00). Last open item of step-1.

## Proven: the whole chat path, with a local stub provider

A stub OpenAI-compatible server on `127.0.0.1:8791` stood in for the model, and the real
server was started against it (`PI_HIVE_BASE_URL`, `PI_HIVE_MODEL=stub-model`,
`PI_HIVE_API_KEY=stub-key` — a dummy value, not a borrowed secret):

```
POST /api/colonies/desktop-demo/scaffold   → {"colony_id":"desktop-demo","created":true}
POST /api/sessions {"colony_id":"desktop-demo"}
  → sess-c0500ab7-b688-42b9-9f61-668354dfc0aa
POST /api/sessions/<id>/chat {"message":"hello queen"} (accept: text/event-stream)
  → {"status":"queen","delivered":true,"execution_id":"sess-c0500ab7-…",
     "reply":"Stub Queen here: the chat path works end to end."}
```

So these are real in that run: the HTTP API, the session store, the Queen runtime, the
pi-agent-core loop and its tool plumbing, the SSE stream, and the reply text reaching the
client. Only the model's words came from the stub.

## Blocked: a model-generated Queen reply, and its screenshot

The remaining contract line is "官方前端桌面端 chat 实测出现 Queen 回复" with a screenshot.
That needs a real provider, and this environment has none:

- `PI_HIVE_API_KEY` and `BROADTOKEN_API_KEY` are unset;
- the pi agent's own configuration may not be borrowed (user instruction);
- Orca's browser CLI on this host exposes identity only, and computer-use would need GUI
  permissions to drive Chrome — not attempted for a screenshot that would still show a
  stub reply.

A screenshot of the stub reply would prove the rendering, not the Queen, so it is not
claimed here.

## To close it

Run, with a key exported in the shell (never committed):

```bash
export PI_HIVE_API_KEY=…            # or BROADTOKEN_API_KEY
unset PI_HIVE_BASE_URL PI_HIVE_MODEL
PI_HIVE_HOME=$PWD/.tmp-home PI_HIVE_PORT=8790 node src/cli.js serve
# open http://127.0.0.1:8790/, create a colony, send one message, screenshot the reply
```

Everything else in this goal is verified in `program/reports/delivery.md`.
