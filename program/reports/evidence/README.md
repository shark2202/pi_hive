# Frontend evidence

Files here are generated, not hand-written.

- `frontend-root.png` — Chrome headless (`--headless=new --window-size=1440,900
  --virtual-time-budget=8000`) screenshot of `http://127.0.0.1:8790/`, i.e. the
  **repo-built** official frontend served by `src/server.js`. 145 KB, so the SPA
  painted rather than returning a blank page.
- `frontend-dom.txt` — the same page's rendered text after 9 s of virtual time,
  with scripts and styles stripped. It is the machine-checkable half of the pair
  (a screenshot cannot be asserted on):

  `Hive Open Hive New Chat Org Chart Configuration Colonies 5 0 1 2 3 4 5 6 7 8 9
   Demo Desktop Demo Disc Demo Server Demo Smoke Queen Queen Bees G Growth Queen …
   S Sales Queen … T Technology Queen … F Finance Queen …`

  That text proves three things in one shot: the frontend bundle boots, it calls the
  pi_hive API for its data (those colony names come from `.tmp-home/colonies`), and
  the 13 built-in Queens are rendered in the Org Chart picker.

Reproduce:

```bash
PI_HIVE_HOME=$PWD/.tmp-home PI_HIVE_PORT=8790 node src/cli.js serve &
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --virtual-time-budget=9000 --dump-dom http://127.0.0.1:8790/
```

What these files do **not** show: a model-generated Queen reply in the chat pane.
That needs `PI_HIVE_API_KEY` (see `program/reports/desktop-chat-e2e.md`).
