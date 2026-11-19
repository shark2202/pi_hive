import { Agent } from "@earendil-works/pi-agent-core";

export function messageText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((c) => c && c.type === "text")
      .map((c) => c.text)
      .join("");
  }
  return "";
}

export function stripReminders(text) {
  return String(text ?? "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, "")
    .trim();
}

export function cleanMessages(messages) {
  return (messages || []).map((message) => {
    if (message.role !== "user") return message;
    if (typeof message.content === "string") {
      return { ...message, content: stripReminders(message.content) };
    }
    if (Array.isArray(message.content)) {
      return {
        ...message,
        content: message.content.map((part) => (
          part?.type === "text" ? { ...part, text: stripReminders(part.text) } : part
        )),
      };
    }
    return message;
  });
}

export function lastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") {
      const text = messageText(m).trim();
      if (text) return text;
    }
  }
  return "";
}

export function createPiAgent({ systemPrompt, tools = [], modelRuntime, onEvent, maxTurns = 40, initialMessages = [], transformContext }) {
  let turns = 0;
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: modelRuntime.model,
      tools,
      ...(initialMessages.length ? { messages: initialMessages } : {}),
    },
    streamFn: modelRuntime.streamFn,
    toolExecution: "parallel",
    ...(transformContext ? { transformContext } : {}),
    finishTurn: async () => {
      if (turns >= maxTurns) return { action: "end" };
      return undefined;
    },
  });

  agent.subscribe((event) => {
    if (event.type === "turn_start") turns += 1;
    onEvent?.(event);
  });

  return agent;
}

export async function runPiAgent({ agent, prompt }) {
  await agent.prompt(prompt);
  await agent.waitForIdle();
  return {
    messages: agent.state.messages,
    text: lastAssistantText(agent.state.messages),
  };
}
