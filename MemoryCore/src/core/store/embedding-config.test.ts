import { describe, expect, it } from "vitest";
import type { MemoryTdaiConfig } from "../../config.js";
import { toOpenAIEmbeddingConfig } from "./embedding-config.js";

describe("toOpenAIEmbeddingConfig", () => {
  it("preserves timeout and compatibility options used by StorePool", () => {
    const config = {
      enabled: true,
      provider: "openai",
      baseUrl: "http://embedding.example.test/v1",
      apiKey: "test-key",
      model: "bge-m3",
      dimensions: 1024,
      sendDimensions: false,
      conflictRecallTopK: 5,
      proxyUrl: "http://proxy.example.test",
      maxInputChars: 4096,
      timeoutMs: 3000,
      recallTimeoutMs: 2000,
      captureTimeoutMs: 10000,
    } satisfies MemoryTdaiConfig["embedding"];

    expect(toOpenAIEmbeddingConfig(config)).toEqual({
      provider: "openai",
      baseUrl: "http://embedding.example.test/v1",
      apiKey: "test-key",
      model: "bge-m3",
      dimensions: 1024,
      sendDimensions: false,
      proxyUrl: "http://proxy.example.test",
      maxInputChars: 4096,
      timeoutMs: 3000,
    });
  });
});
