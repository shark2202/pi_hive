import { createTask, listTasks, updateTask } from "../domain/plan.js";
import { listSkills, writeSkill } from "../domain/skills.js";

export function textResult(value, details = {}, extra = {}) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], details, ...extra };
}

export function errorResult(message) {
  return { content: [{ type: "text", text: `ERROR: ${message}` }], details: { error: message }, isError: true };
}

const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

export function trackerTools(tracker) {
  return [
    {
      name: "tracker_query",
      label: "Tracker query",
      description: "Run a read-only SQL SELECT against this colony's tracker. Returns rows as JSON.",
      parameters: object({ sql: { type: "string", description: "SELECT or WITH statement" } }, ["sql"]),
      async execute(_id, params) {
        try {
          return textResult(tracker.query(params.sql));
        } catch (err) {
          return errorResult(err.message);
        }
      },
    },
    {
      name: "tracker_upsert",
      label: "Tracker upsert",
      description: "Insert or update one row in a tracker table. The row must include the key column (default: id).",
      parameters: object({
        table: { type: "string" },
        row: { type: "object", additionalProperties: true },
        key: { type: "string", description: "Conflict key column; default id" },
      }, ["table", "row"]),
      async execute(_id, params) {
        try {
          const result = tracker.upsert(params.table, params.row, params.key || "id");
          return textResult({ ok: true, changes: result.changes ?? null }, { table: params.table });
        } catch (err) {
          return errorResult(err.message);
        }
      },
    },
    {
      name: "tracker_sql",
      label: "Tracker SQL",
      description: "Run a DDL/DML statement on the tracker (CREATE TABLE, ALTER, INSERT). Use tracker_query for SELECT.",
      parameters: object({ sql: { type: "string" } }, ["sql"]),
      async execute(_id, params) {
        try {
          if (/^\s*(select|with)\b/i.test(params.sql)) return errorResult("use tracker_query for SELECT");
          return textResult(tracker.exec(params.sql));
        } catch (err) {
          return errorResult(err.message);
        }
      },
    },
  ];
}

export function planTools(colony) {
  return [
    {
      name: "task_create",
      label: "Create task",
      description: "Add a task to the colony's persistent plan.",
      parameters: object({
        subject: { type: "string" },
        description: { type: "string" },
      }, ["subject"]),
      async execute(_id, params) {
        return textResult(createTask(colony, params));
      },
    },
    {
      name: "task_update",
      label: "Update task",
      description: "Update a task's status or fields.",
      parameters: object({
        id: { type: "string" },
        status: { type: "string", enum: ["pending", "in_progress", "blocked", "completed", "archived"] },
        subject: { type: "string" },
        description: { type: "string" },
      }, ["id"]),
      async execute(_id, params) {
        try {
          const { id, ...patch } = params;
          return textResult(updateTask(colony, id, patch));
        } catch (err) {
          return errorResult(err.message);
        }
      },
    },
    {
      name: "task_list",
      label: "List tasks",
      description: "List the colony plan's tasks, optionally filtered by status.",
      parameters: object({ status: { type: "string" } }),
      async execute(_id, params) {
        return textResult(listTasks(colony, params.status));
      },
    },
  ];
}

export function skillTools(colony) {
  return [
    {
      name: "list_skills",
      label: "List skills",
      description: "List the colony's skills (name and description).",
      parameters: object({}),
      async execute() {
        return textResult(listSkills(colony).map(({ name, description }) => ({ name, description })));
      },
    },
    {
      name: "write_skill",
      label: "Write skill",
      description: "Write a reusable SKILL.md into the colony. Include the method, edge cases, and how to record results.",
      parameters: object({
        name: { type: "string" },
        description: { type: "string" },
        body: { type: "string" },
      }, ["name", "body"]),
      async execute(_id, params) {
        try {
          return textResult(writeSkill(colony, params));
        } catch (err) {
          return errorResult(err.message);
        }
      },
    },
  ];
}

export function workerReportTool(onReport) {
  return {
    name: "report_to_parent",
    label: "Report to Queen",
    description: "Your terminal action. Report success, partial, or failed with a concise summary and optional structured data.",
    parameters: object({
      status: { type: "string", enum: ["success", "partial", "failed"] },
      summary: { type: "string" },
      data: { type: "object", additionalProperties: true },
    }, ["status", "summary"]),
    async execute(_id, params) {
      const report = {
        status: params.status,
        summary: params.summary,
        data: params.data || {},
        at: new Date().toISOString(),
      };
      onReport(report);
      return textResult({ ok: true }, { report }, { terminate: true });
    },
  };
}

export function soulTools({ engine }) {
  return [
    {
      name: "soul_read",
      label: "Soul",
      description: "Read this colony's Soul (mission, voice, principles), pending proposals, and history.",
      parameters: object({}),
      async execute() {
        try { return textResult(engine().status()); } catch (err) { return errorResult(err.message); }
      },
    },
    {
      name: "soul_review",
      label: "Review soul",
      description: "Review recent transcript and memory, then write evidence-backed Soul proposals. Does not apply in review mode.",
      parameters: object({}),
      async execute() {
        try { return textResult(await engine().review()); } catch (err) { return errorResult(err.message); }
      },
    },
    {
      name: "soul_apply",
      label: "Apply soul proposal",
      description: "Apply one pending Soul proposal by id. Use after reviewing its evidence.",
      parameters: object({ id: { type: "string" } }, ["id"]),
      async execute(_id, params) {
        try { return textResult(engine().apply(params.id)); } catch (err) { return errorResult(err.message); }
      },
    },
  ];
}

