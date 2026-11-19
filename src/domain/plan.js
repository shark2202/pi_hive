import fs from "node:fs";
import { colonyPaths } from "./colony.js";

function read(name) {
  const p = colonyPaths(name).plan;
  if (!fs.existsSync(p)) return { goal: "", tasks: [] };
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function write(name, plan) {
  fs.writeFileSync(colonyPaths(name).plan, JSON.stringify(plan, null, 2));
  return plan;
}

export function getPlan(name) {
  return read(name);
}

export function createTask(name, { subject, description = "", status = "pending" }) {
  const plan = read(name);
  const id = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const task = { id, subject, description, status, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  plan.tasks.push(task);
  write(name, plan);
  return task;
}

export function updateTask(name, id, patch) {
  const plan = read(name);
  const task = plan.tasks.find((t) => t.id === id);
  if (!task) throw new Error(`task '${id}' not found`);
  Object.assign(task, patch, { updated_at: new Date().toISOString() });
  write(name, plan);
  return task;
}

export function listTasks(name, status) {
  const tasks = read(name).tasks || [];
  return status ? tasks.filter((t) => t.status === status) : tasks;
}
