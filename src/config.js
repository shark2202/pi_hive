import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const PI_HIVE_VERSION = "0.1.0";

export function hiveHome() {
  return process.env.PI_HIVE_HOME || path.join(os.homedir(), ".pi-hive");
}

export function coloniesDir() {
  return path.join(hiveHome(), "colonies");
}

export function colonyDir(name) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    throw new Error("colony name must be lowercase alphanumeric (with - or _), start with a letter/digit, and be <=64 chars");
  }
  return path.join(coloniesDir(), name);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function modelConfig() {
  const baseUrl = process.env.PI_HIVE_BASE_URL || "https://token.tokenbroad.com/v1";
  const modelId = process.env.PI_HIVE_MODEL || "deepseek-flash-1017";
  const apiKey = process.env.PI_HIVE_API_KEY || process.env.BROADTOKEN_API_KEY || "";
  return { baseUrl, modelId, apiKey };
}

export function serverConfig() {
  return {
    host: process.env.PI_HIVE_HOST || "127.0.0.1",
    port: Number(process.env.PI_HIVE_PORT || 8790),
  };
}

export function queenDefaults() {
  return {
    idleNudgeSeconds: Number(process.env.PI_HIVE_IDLE_SECONDS || 120),
    maxWorkerTurns: Number(process.env.PI_HIVE_WORKER_TURNS || 10),
    maxQueenTurns: Number(process.env.PI_HIVE_QUEEN_TURNS || 40),
    maxConcurrentWorkers: Number(process.env.PI_HIVE_MAX_WORKERS || 4),
  };
}
