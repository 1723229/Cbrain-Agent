import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("gateway recall and ordering configuration", () => {
  it("uses API-key authentication without static gateway principals", () => {
    expect(loadConfig({})).toMatchObject({ authCacheTtlMs: 30_000, authNegativeCacheTtlMs: 3_000, authCacheMaxEntries: 1_000 });
  });
  it("uses bounded low-latency defaults", () => {
    const config = loadConfig({});
    expect(config.recallTimeoutMs).toBe(800);
    expect(config.recallMinScore).toBe(0.75);
    expect(config.skillSettleMs).toBe(5000);
    expect(config.captureConcurrency).toBe(4);
    expect(config.captureMaxAttempts).toBe(8);
    expect(config.captureTimeoutMs).toBe(30_000);
  });

  it("accepts valid timing overrides", () => {
    expect(loadConfig({ CBRAIN_RECALL_TIMEOUT_MS: "600", CBRAIN_RECALL_MIN_SCORE: "0.8", CBRAIN_SKILL_SETTLE_MS: "7000", CBRAIN_CAPTURE_CONCURRENCY: "6", CBRAIN_CAPTURE_MAX_ATTEMPTS: "5", CBRAIN_CAPTURE_TIMEOUT_MS: "45000" })).toMatchObject({ recallTimeoutMs: 600, recallMinScore: 0.8, skillSettleMs: 7000, captureConcurrency: 6, captureMaxAttempts: 5, captureTimeoutMs: 45_000 });
  });
});
