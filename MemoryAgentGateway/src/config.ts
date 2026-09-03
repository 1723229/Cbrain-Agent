import { resolve } from "node:path";
import type { CoreClientConfig } from "./types.js";

export interface GatewayConfig {
  host: string;
  port: number;
  authCacheTtlMs: number;
  authNegativeCacheTtlMs: number;
  authCacheMaxEntries: number;
  core: CoreClientConfig;
  knowledgeBaseUrl: string;
  knowledgeServiceId: string;
  knowledgeToken?: string;
  knowledgeIds: string[];
  profileMaxChars: number;
  databasePath: string;
  contextTtlMs: number;
  capturePollMs: number;
  recallTimeoutMs: number;
  recallMinScore:number;
  sessionContextTimeoutMs:number;
  knowledgeCacheTtlMs:number;
  skillSettleMs: number;
  captureConcurrency: number;
  captureMaxAttempts: number;
  captureTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const serviceId = env.CBRAIN_SERVICE_ID?.trim() || "default";
  const serviceToken = env.CBRAIN_SERVICE_TOKEN?.trim();
  return {
    host: env.CBRAIN_AGENT_GATEWAY_HOST?.trim() || "0.0.0.0",
    port: integer(env.CBRAIN_AGENT_GATEWAY_PORT, 8430),
    authCacheTtlMs: integer(env.CBRAIN_AUTH_CACHE_TTL_MS, 30_000),
    authNegativeCacheTtlMs: integer(env.CBRAIN_AUTH_NEGATIVE_CACHE_TTL_MS, 3_000),
    authCacheMaxEntries: integer(env.CBRAIN_AUTH_CACHE_MAX_ENTRIES, 1_000),
    core: {
      baseUrl: env.CBRAIN_CORE_URL?.trim() || "http://127.0.0.1:8420",
      serviceId,
      token: serviceToken,
      timeoutMs: integer(env.CBRAIN_TIMEOUT_MS, 5000),
    },
    knowledgeBaseUrl: env.CBRAIN_KNOWLEDGE_URL?.trim() || "http://127.0.0.1:8424",
    knowledgeServiceId: env.CBRAIN_KNOWLEDGE_SERVICE_ID?.trim() || serviceId,
    knowledgeToken: env.CBRAIN_KNOWLEDGE_TOKEN?.trim() || serviceToken,
    knowledgeIds: split(env.CBRAIN_KNOWLEDGE_IDS),
    profileMaxChars: integer(env.CBRAIN_PROFILE_MAX_CHARS, 6000),
    databasePath: resolve(env.CBRAIN_AGENT_GATEWAY_DB?.trim() || "./data/gateway.sqlite"),
    contextTtlMs: integer(env.CBRAIN_CONTEXT_TTL_MS, 24 * 60 * 60_000),
    capturePollMs: integer(env.CBRAIN_CAPTURE_POLL_MS, 2_000),
    recallTimeoutMs: integer(env.CBRAIN_RECALL_TIMEOUT_MS, 800),
    recallMinScore:decimal(env.CBRAIN_RECALL_MIN_SCORE,0.75,0,1),
    sessionContextTimeoutMs:integer(env.CBRAIN_SESSION_CONTEXT_TIMEOUT_MS,1500),
    knowledgeCacheTtlMs:integer(env.CBRAIN_KNOWLEDGE_CACHE_TTL_MS,30_000),
    skillSettleMs: integer(env.CBRAIN_SKILL_SETTLE_MS, 5_000),
    captureConcurrency: integer(env.CBRAIN_CAPTURE_CONCURRENCY, 4),
    captureMaxAttempts: integer(env.CBRAIN_CAPTURE_MAX_ATTEMPTS, 8),
    captureTimeoutMs: integer(env.CBRAIN_CAPTURE_TIMEOUT_MS, 30_000),
  };
}
function integer(value: string | undefined, fallback: number): number { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
function split(value: string | undefined): string[] { return value ? [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))] : []; }
function decimal(value:string|undefined,fallback:number,min:number,max:number):number{const parsed=Number(value);return Number.isFinite(parsed)&&parsed>=min&&parsed<=max?parsed:fallback}
