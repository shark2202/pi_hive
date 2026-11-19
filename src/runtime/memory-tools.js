import { readMemory, writeMemory, searchMemory } from "../domain/memory.js";

export function memoryTools({ colony, queenId = "queen_growth", writable = true }) {
  const tools = [
    {
      name: "memory_read",
      label: "Read memory",
      description: "Read durable memory for a scope: global, queen, or colony.",
      parameters: {
        type: "object",
        properties: { scope: { type: "string", enum: ["global", "queen", "colony"] } },
        additionalProperties: false,
      },
      async execute(_id, params) {
        return { content: [{ type: "text", text: readMemory(colony, params.scope || "global", queenId) || "(empty)" }], details: {} };
      },
    },
    {
      name: "memory_search",
      label: "Search memory",
      description: "Keyword search across global, queen, and colony memory.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
      async execute(_id, params) {
        return {
          content: [{ type: "text", text: JSON.stringify(searchMemory(colony, params.query, queenId), null, 2) }],
          details: {},
        };
      },
    },
  ];
  if (writable) {
    tools.push({
      name: "memory_write",
      label: "Write memory",
      description: "Write or replace a durable memory file. Keep it short and factual; one topic per file.",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["global", "queen", "colony"] },
          filename: { type: "string" },
          content: { type: "string" },
        },
        required: ["scope", "filename", "content"],
        additionalProperties: false,
      },
      async execute(_id, params) {
        try {
          return { content: [{ type: "text", text: writeMemory(colony, params.scope, params.filename, params.content, queenId) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: `ERROR: ${err.message}` }], details: {}, isError: true };
        }
      },
    });
  }
  return tools;
}
