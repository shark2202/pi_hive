import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { colonyPaths, loadMetadata } from "../domain/colony.js";

const execAsync = promisify(exec);

function workspaceRoot(colony) {
  const meta = loadMetadata(colony) || {};
  return path.resolve(meta.workspace || process.env.PI_HIVE_WORKSPACE || colonyPaths(colony).dir);
}

function safePath(root, p) {
  const abs = path.resolve(root, p || ".");
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path escapes workspace: ${p}`);
  return abs;
}

export function fsTools(colony) {
  const root = workspaceRoot(colony);
  return [
    {
      name: "file_read",
      label: "Read file",
      description: `Read a UTF-8 text file under the workspace (${root}).`,
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      async execute(_id, params) {
        try {
          const file = safePath(root, params.path);
          const text = fs.readFileSync(file, "utf8");
          return { content: [{ type: "text", text: text.slice(0, 200000) }], details: { path: file, bytes: text.length } };
        } catch (err) {
          return { content: [{ type: "text", text: `ERROR: ${err.message}` }], details: {}, isError: true };
        }
      },
    },
    {
      name: "file_write",
      label: "Write file",
      description: `Write a UTF-8 text file under the workspace (${root}). Creates parent directories.`,
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
      async execute(_id, params) {
        try {
          const file = safePath(root, params.path);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, params.content, "utf8");
          return { content: [{ type: "text", text: `wrote ${file}` }], details: { path: file } };
        } catch (err) {
          return { content: [{ type: "text", text: `ERROR: ${err.message}` }], details: {}, isError: true };
        }
      },
    },
    {
      name: "file_edit",
      label: "Edit file",
      description: "Replace one exact string in a text file. Fails if the old string is not unique.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
        required: ["path", "old", "new"],
        additionalProperties: false,
      },
      async execute(_id, params) {
        try {
          const file = safePath(root, params.path);
          const text = fs.readFileSync(file, "utf8");
          const first = text.indexOf(params.old);
          if (first < 0) throw new Error("old string not found");
          if (text.indexOf(params.old, first + 1) >= 0) throw new Error("old string is not unique");
          fs.writeFileSync(file, text.slice(0, first) + params.new + text.slice(first + params.old.length), "utf8");
          return { content: [{ type: "text", text: `edited ${file}` }], details: { path: file } };
        } catch (err) {
          return { content: [{ type: "text", text: `ERROR: ${err.message}` }], details: {}, isError: true };
        }
      },
    },
    {
      name: "file_search",
      label: "Search files",
      description: "Search text files under the workspace for a fixed string. Returns path:line matches.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, path: { type: "string" }, limit: { type: "number" } },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(_id, params) {
        try {
          const base = safePath(root, params.path || ".");
          const limit = Math.min(200, Math.max(1, Number(params.limit || 50)));
          const hits = [];
          const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              if (hits.length >= limit) return;
              if (entry.name === "node_modules" || entry.name === ".git") continue;
              const full = path.join(dir, entry.name);
              if (entry.isDirectory()) walk(full);
              else if (entry.isFile() && /\.(md|txt|js|mjs|cjs|ts|tsx|json|py|go|yml|yaml|toml|css|html)$/.test(entry.name)) {
                const lines = fs.readFileSync(full, "utf8").split("\n");
                lines.forEach((line, i) => {
                  if (hits.length < limit && line.includes(params.query)) hits.push(`${path.relative(root, full)}:${i + 1}: ${line.trim()}`);
                });
              }
            }
          };
          walk(base);
          return { content: [{ type: "text", text: hits.join("\n") || "(no matches)" }], details: { path: base, matches: hits.length } };
        } catch (err) {
          return { content: [{ type: "text", text: `ERROR: ${err.message}` }], details: {}, isError: true };
        }
      },
    },
    {
      name: "terminal_exec",
      label: "Terminal",
      description: `Run a shell command with cwd under the workspace (${root}). Returns stdout/stderr.`,
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
          timeout_seconds: { type: "number" },
        },
        required: ["command"],
        additionalProperties: false,
      },
      async execute(_id, params) {
        try {
          const cwd = safePath(root, params.cwd || ".");
          const timeout = Math.min(600, Math.max(1, Number(params.timeout_seconds || 30))) * 1000;
          const { stdout, stderr } = await execAsync(params.command, {
            cwd,
            timeout,
            maxBuffer: 2 * 1024 * 1024,
            shell: process.env.SHELL || "/bin/sh",
          });
          return {
            content: [{ type: "text", text: `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.slice(0, 200000) || "(no output)" }],
            details: { cwd, command: params.command },
          };
        } catch (err) {
          const text = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n");
          return { content: [{ type: "text", text: text.slice(0, 200000) }], details: { cwd: params.cwd || "." }, isError: true };
        }
      },
    },
  ];
}
