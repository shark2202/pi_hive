#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { PI_HIVE_VERSION, serverConfig } from "./config.js";
import { exportColonyToFile, importColony } from "./domain/archive.js";
import { reflectMemory } from "./domain/memory.js";
import { createColony, listColonies, loadMetadata } from "./domain/colony.js";
import { openTracker } from "./domain/tracker.js";
import { createModelRuntime } from "./kernel/model.js";
import { QueenRuntime } from "./runtime/queen.js";
import { PlaybookRunner } from "./runtime/playbook.js";
import { TriggerManager } from "./runtime/triggers.js";
import { runWorker } from "./runtime/worker.js";
import { PiHiveServer } from "./server.js";

function usage() {
  console.log(`pi-hive ${PI_HIVE_VERSION} — Hive orchestration on the pi-agent kernel

Usage:
  pi-hive serve
  pi-hive colony create <name> [--queen queen_growth] [--goal "..." ]
  pi-hive colony list
  pi-hive chat <colony> <message>
  pi-hive worker <colony> <task>
  pi-hive playbook run <colony> <name>
  pi-hive tracker <colony> [sql]
  pi-hive trigger list <colony>
  pi-hive export <colony> <file.tar.gz>
  pi-hive import <file.tar.gz> [--name <colony>] [--overwrite]
  pi-hive memory reflect <colony> [--force]
`);
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function runtimeFor(colony) {
  const meta = loadMetadata(colony);
  if (!meta) throw new Error(`colony '${colony}' not found`);
  const modelRuntime = createModelRuntime();
  const queen = new QueenRuntime({ colony, queenId: meta.queen_id || "queen_growth", modelRuntime });
  queen.playbookRunner = new PlaybookRunner({ workerManager: queen.workerManager });
  queen.triggerManager = new TriggerManager({ colony, onFire: () => {} });
  return queen;
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === "help" || cmd === "--help") return usage();

  if (cmd === "serve") {
    const server = new PiHiveServer();
    const addr = await server.start();
    console.log(`pi-hive ${PI_HIVE_VERSION} listening on ${addr.url}`);
    const shutdown = async () => { await server.stop(); process.exit(0); };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  if (cmd === "colony") {
    const sub = process.argv[3];
    if (sub === "create") {
      const name = process.argv[4];
      if (!name) throw new Error("colony name required");
      const meta = createColony({
        name,
        queenId: arg("queen", "queen_growth"),
        goal: arg("goal", ""),
        workspace: arg("workspace", ""),
        sentinelEnabled: process.argv.includes("--sentinel"),
      });
      console.log(JSON.stringify(meta, null, 2));
      return;
    }
    if (sub === "list") {
      console.log(JSON.stringify(listColonies(), null, 2));
      return;
    }
    return usage();
  }

  if (cmd === "chat") {
    const colony = process.argv[3];
    const text = process.argv.slice(4).join(" ");
    if (!colony || !text) throw new Error("usage: pi-hive chat <colony> <message>");
    const queen = runtimeFor(colony);
    try {
      const result = await queen.chat(text);
      console.log(result.text);
    } finally {
      queen.stop();
    }
    return;
  }

  if (cmd === "worker") {
    const colony = process.argv[3];
    const task = process.argv.slice(4).join(" ");
    if (!colony || !task) throw new Error("usage: pi-hive worker <colony> <task>");
    const meta = loadMetadata(colony);
    const report = await runWorker({
      colony,
      queenId: meta?.queen_id || "queen_growth",
      modelRuntime: createModelRuntime(),
      task,
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (cmd === "playbook") {
    const sub = process.argv[3];
    if (sub === "run") {
      const colony = process.argv[4];
      const name = process.argv[5];
      if (!colony || !name) throw new Error("usage: pi-hive playbook run <colony> <name>");
      const queen = runtimeFor(colony);
      try {
        const run = await queen.playbookRunner.start({ colony, name });
        console.log(JSON.stringify(run, null, 2));
        await queen.playbookRunner.wait(run.run_id);
        console.log(JSON.stringify(queen.playbookRunner.status(run.run_id), null, 2));
      } finally {
        queen.stop();
      }
      return;
    }
    return usage();
  }

  if (cmd === "tracker") {
    const colony = process.argv[3];
    if (!colony) throw new Error("usage: pi-hive tracker <colony> [sql]");
    const sql = process.argv.slice(4).join(" ") || "SELECT name FROM sqlite_master WHERE type='table'";
    const tracker = openTracker(colony);
    try {
      console.log(JSON.stringify(tracker.query(sql), null, 2));
    } finally {
      tracker.close();
    }
    return;
  }

  if (cmd === "memory") {
    const sub = process.argv[3];
    const colony = process.argv[4];
    if (sub !== "reflect" || !colony) return usage();
    const result = reflectMemory(colony, { force: process.argv.includes("--force") });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === "export") {
    const colony = process.argv[3];
    const file = process.argv[4];
    if (!colony || !file) return usage();
    const result = exportColonyToFile(colony, file);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === "import") {
    const file = process.argv[3];
    if (!file) return usage();
    const archive = fs.readFileSync(path.resolve(file));
    const result = importColony(archive, {
      name: arg("name"),
      overwrite: process.argv.includes("--overwrite"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === "trigger") {
    const sub = process.argv[3];
    const colony = process.argv[4];
    if (sub !== "list" || !colony) return usage();
    const queen = runtimeFor(colony);
    console.log(JSON.stringify(queen.triggerManager?.list() || [], null, 2));
    queen.stop();
    return;
  }

  usage();
}

main().catch((err) => {
  console.error(`pi-hive: ${err.stack || err.message}`);
  process.exit(1);
});
