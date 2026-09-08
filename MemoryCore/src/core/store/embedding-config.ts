import type { MemoryTdaiConfig } from "../../config.js";
import type { OpenAIEmbeddingConfig } from "./embedding.js";

/**
 * Keep every remote embedding option when wiring either the single store or
 * the per-instance StorePool. Missing fields here silently fall back to the
 * embedding client's defaults and make the runtime disagree with config.
 */
export function toOpenAIEmbeddingConfig(
  config: MemoryTdaiConfig["embedding"],
): OpenAIEmbeddingConfig {
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    dimensions: config.dimensions,
    sendDimensions: config.sendDimensions,
    proxyUrl: config.proxyUrl,
    maxInputChars: config.maxInputChars,
    timeoutMs: config.timeoutMs,
  };
}
