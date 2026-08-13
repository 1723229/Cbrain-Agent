import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const required = { HIPER_AGENT_GATEWAY_TOKEN: "token", HIPER_USER_ID: "user" };

describe("gateway recall and ordering configuration", () => {
  it("uses bounded low-latency defaults", () => {
    const config = loadConfig(required);
    expect(config.recallTimeoutMs).toBe(800);
    expect(config.recallMinScore).toBe(0.75);
    expect(config.skillSettleMs).toBe(5000);
    expect(config.captureConcurrency).toBe(4);
    expect(config.captureMaxAttempts).toBe(8);
  });

  it("accepts valid timing overrides", () => {
    expect(loadConfig({ ...required, HIPER_RECALL_TIMEOUT_MS: "600", HIPER_RECALL_MIN_SCORE: "0.8", HIPER_SKILL_SETTLE_MS: "7000", HIPER_CAPTURE_CONCURRENCY: "6", HIPER_CAPTURE_MAX_ATTEMPTS: "5" })).toMatchObject({ recallTimeoutMs: 600, recallMinScore: 0.8, skillSettleMs: 7000, captureConcurrency: 6, captureMaxAttempts: 5 });
  });
});
