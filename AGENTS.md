# pi_hive agent notes

- **pi-agent-core is the kernel.** Do not reimplement the agent loop, tool executor, streaming, or transcript. Add Hive-shaped substrates around `Agent`.
- Plain ESM JavaScript, no build step. Node >= 22.19.
- Keep `docs/PARITY.md` honest. A feature is ✅ only when code + a test/smoke + docs exist.
- Unit tests must not require a model: `npm test`.
- Smoke tests may call a real model; require `PI_HIVE_API_KEY` and never commit keys.
- Colony state belongs in `~/.pi-hive` or `PI_HIVE_HOME`; tests use temp dirs.
- Do not commit generated data (`.tmp-home/`, `node_modules/`, colony data).
- Playbooks are JavaScript modules (`meta` + `async run(ctx)`), not Python. Keep the contract in `docs/ARCHITECTURE.md` in sync.
- The native dashboard is vanilla JS in `src/ui`, served at `/ui/`; no build step, no framework.
- `/` serves the official Hive frontend from `/Users/mac/hive/core/frontend/dist` (override `HIVE_FRONTEND_DIST`). Do not edit that build; add compatibility API handlers instead.
- Before claiming a native UI change works, verify `/ui/` at desktop (1440x900) and mobile (390x844) widths: no horizontal overflow, no overlap, and chat/SSE works. The official frontend is desktop-first; do not claim it is responsive until verified.
- Sentinel is opt-in (`sentinel_enabled` on colony or `PI_HIVE_SENTINEL=1`); it writes `inbox.jsonl` and can POST to `PI_HIVE_SENTINEL_WEBHOOK`.
- Prefer small modules under `src/domain`, `src/kernel`, `src/runtime`; avoid a growing `server.js`.
