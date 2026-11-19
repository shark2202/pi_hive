import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const baseUrl = process.env.PI_HIVE_BASE_URL || "https://token.tokenbroad.com/v1";
const modelId = process.env.PI_HIVE_MODEL || "deepseek-flash-1017";

const model = {
  id: modelId,
  name: modelId,
  api: "openai-completions",
  provider: "pihive",
  baseUrl,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
  reasoning: false,
};

const provider = createProvider({
  id: "pihive",
  name: "Pi Hive",
  baseUrl,
  auth: { apiKey: envApiKeyAuth("Pi Hive API key", ["PI_HIVE_API_KEY", "BROADTOKEN_API_KEY"]) },
  models: [model],
  api: openAICompletionsApi(),
});

const models = createModels();
models.setProvider(provider);
const bound = models.getModel("pihive", modelId);
if (!bound) throw new Error("model not found");

const agent = new Agent({
  initialState: {
    systemPrompt: "You are a terse test agent. Reply with exactly: PI_HIVE_OK",
    model: bound,
  },
  streamFn: models.streamSimple.bind(models),
});

agent.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await agent.prompt("Ping.");
console.log("\nprompt finished");
