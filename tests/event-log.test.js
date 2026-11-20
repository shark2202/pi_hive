/**
 * The durable colony event log: append, replay from a cursor, and survive a crash
 * mid-line without throwing or duplicating.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { createColony } from "../src/domain/colony.js";
import { appendEvent, eventCursor, eventLogPath, persistEvents, readEvents } from "../src/domain/event-log.js";

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-events-")));
process.env.PI_HIVE_HOME = HOME;

after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

function seed(name) {
  fs.rmSync(path.join(HOME, "colonies", name), { recursive: true, force: true });
  createColony({ name, goal: "log everything" });
  return name;
}

test("events append to a JSONL log and replay in order", () => {
  const colony = seed("ev-basic");
  assert.equal(eventCursor(colony), 0);
  assert.deepEqual(readEvents(colony), { events: [], cursor: 0, skipped: 0, truncated: false });

  const first = appendEvent(colony, { type: "queen_event", text: "hello" });
  assert.ok(first.cursor > 0);
  const second = appendEvent(colony, { type: "delta", text: " world" });
  assert.ok(second.cursor > first.cursor);

  const replay = readEvents(colony);
  assert.deepEqual(replay.events.map((event) => [event.type, event.text]), [
    ["queen_event", "hello"],
    ["delta", " world"],
  ]);
  assert.ok(replay.events[0].at, "each record carries a timestamp");
  assert.equal(replay.cursor, second.cursor);

  // Replaying from the first cursor returns only what came after it.
  const tail = readEvents(colony, { cursor: first.cursor });
  assert.deepEqual(tail.events.map((event) => event.text), [" world"]);

  assert.equal(appendEvent(colony, { text: "no type" }), null, "an event without a type is refused");
  assert.equal(fs.readFileSync(eventLogPath(colony), "utf8").trim().split("\n").length, 2);
});

test("a half-written line is skipped and the cursor stays usable", () => {
  const colony = seed("ev-crash");
  appendEvent(colony, { type: "one" });
  fs.appendFileSync(eventLogPath(colony), '{"type":"two","text":"trunc');
  const partialCursor = eventCursor(colony);

  const replay = readEvents(colony);
  assert.deepEqual(replay.events.map((event) => event.type), ["one"], "the partial line is not an event");

  // Finish the line: the reader resumes cleanly from the cursor it returned.
  fs.appendFileSync(eventLogPath(colony), 'ated"}\n');
  const after = readEvents(colony, { cursor: replay.cursor });
  assert.equal(after.skipped, 0, "the line parses now that it is complete");
  assert.deepEqual(after.events.map((event) => event.type), ["two"]);

  // A genuinely corrupt line is counted, not thrown.
  fs.appendFileSync(eventLogPath(colony), "not json at all\n");
  appendEvent(colony, { type: "three" });
  const mixed = readEvents(colony, { cursor: after.cursor });
  assert.equal(mixed.skipped, 1);
  assert.deepEqual(mixed.events.map((event) => event.type), ["three"]);

  // A cursor in the middle of a line aligns forward instead of yielding garbage.
  const middle = Math.floor(partialCursor / 2);
  const aligned = readEvents(colony, { cursor: middle });
  for (const event of aligned.events) assert.equal(typeof event.type, "string");
});

test("a huge event is trimmed instead of bloating the log", () => {
  const colony = seed("ev-big");
  const big = "x".repeat(40000);
  appendEvent(colony, { type: "tool_result", text: big });
  const [event] = readEvents(colony).events;
  assert.equal(event.truncated, true);
  assert.ok(event.text.length <= 4000, "the oversized text is cut");
  assert.ok(eventCursor(colony) < 20000, "the log stays small");
});

test("persisting an emitter never breaks the live path", () => {
  const colony = seed("ev-emitter");
  const emitter = persistEvents(colony, new EventEmitter());
  const seen = [];
  emitter.on("queen_event", (payload) => seen.push(payload.text));

  emitter.emit("queen_event", { text: "live" });
  emitter.emit("queen_event", { text: "again" });
  assert.deepEqual(seen, ["live", "again"], "listeners still receive the event");

  const replayed = readEvents(colony).events;
  assert.deepEqual(replayed.map((event) => [event.type, event.text]), [
    ["queen_event", "live"],
    ["queen_event", "again"],
  ]);

  // A payload that cannot be serialised must not throw out of emit().
  const cyclic = {};
  cyclic.self = cyclic;
  assert.doesNotThrow(() => emitter.emit("queen_event", cyclic));
  assert.deepEqual(seen.length, 3);
});
