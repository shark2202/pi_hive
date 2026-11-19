import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { modelConfig } from "../config.js";

export function createModelRuntime(overrides = {}) {
  const cfg = { ...modelConfig(), ...overrides };
  if (!cfg.apiKey) {
    throw new Error("no model API key: set PI_HIVE_API_KEY or BROADTOKEN_API_KEY");
  }
  const model = {
    id: cfg.modelId,
    name: cfg.modelId,
    api: "openai-completions",
    provider: "pihive",
    baseUrl: cfg.baseUrl,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    reasoning: false,
  };
  const provider = createProvider({
    id: "pihive",
    name: "Pi Hive",
    baseUrl: cfg.baseUrl,
    auth: { apiKey: envApiKeyAuth("Pi Hive API key", ["PI_HIVE_API_KEY", "BROADTOKEN_API_KEY"]) },
    models: [model],
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  const bound = models.getModel("pihive", cfg.modelId);
  if (!bound) throw new Error(`model '${cfg.modelId}' not found in provider`);
  return {
    models,
    model: bound,
    streamFn: models.streamSimple.bind(models),
    config: cfg,
  };
}
