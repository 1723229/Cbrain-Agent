import { resolve } from "node:path";
import type { CoreClientConfig, GatewayPrincipal } from "./types.js";

export interface GatewayConfig {
  host: string;
  port: number;
  principals: GatewayPrincipal[];
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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const serviceId = env.HIPER_SERVICE_ID?.trim() || "default";
  const serviceToken = env.HIPER_SERVICE_TOKEN?.trim() || env.HIPER_API_KEY?.trim();
  return {
    host: env.HIPER_AGENT_GATEWAY_HOST?.trim() || "0.0.0.0",
    port: integer(env.HIPER_AGENT_GATEWAY_PORT, 8430),
    principals: loadPrincipals(env),
    authCacheTtlMs: integer(env.HIPER_AUTH_CACHE_TTL_MS, 30_000),
    authNegativeCacheTtlMs: integer(env.HIPER_AUTH_NEGATIVE_CACHE_TTL_MS, 3_000),
    authCacheMaxEntries: integer(env.HIPER_AUTH_CACHE_MAX_ENTRIES, 1_000),
    core: {
      baseUrl: env.HIPER_CORE_URL?.trim() || "http://127.0.0.1:8420",
      serviceId,
      token: serviceToken,
      timeoutMs: integer(env.HIPER_TIMEOUT_MS, 5000),
    },
    knowledgeBaseUrl: env.HIPER_KNOWLEDGE_URL?.trim() || "http://127.0.0.1:8424",
    knowledgeServiceId: env.KNOWLEDGE_SERVICE_ID?.trim() || serviceId,
    knowledgeToken: env.KNOWLEDGE_API_TOKEN?.trim() || serviceToken,
    knowledgeIds: split(env.HIPER_KNOWLEDGE_IDS),
    profileMaxChars: integer(env.HIPER_PROFILE_MAX_CHARS, 6000),
    databasePath: resolve(env.HIPER_AGENT_GATEWAY_DB?.trim() || "./data/gateway.sqlite"),
    contextTtlMs: integer(env.HIPER_CONTEXT_TTL_MS, 24 * 60 * 60_000),
    capturePollMs: integer(env.HIPER_CAPTURE_POLL_MS, 2_000),
    recallTimeoutMs: integer(env.HIPER_RECALL_TIMEOUT_MS, 800),
    recallMinScore:decimal(env.HIPER_RECALL_MIN_SCORE,0.75,0,1),
    sessionContextTimeoutMs:integer(env.HIPER_SESSION_CONTEXT_TIMEOUT_MS,1500),
    knowledgeCacheTtlMs:integer(env.HIPER_KNOWLEDGE_CACHE_TTL_MS,30_000),
    skillSettleMs: integer(env.HIPER_SKILL_SETTLE_MS, 5_000),
    captureConcurrency: integer(env.HIPER_CAPTURE_CONCURRENCY, 4),
    captureMaxAttempts: integer(env.HIPER_CAPTURE_MAX_ATTEMPTS, 8),
  };
}

function loadPrincipals(env: NodeJS.ProcessEnv): GatewayPrincipal[] {
  const raw = env.HIPER_GATEWAY_PRINCIPALS_JSON?.trim();
  if (raw) {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("HIPER_GATEWAY_PRINCIPALS_JSON must be a non-empty array");
    const principals = parsed.map((item, index) => normalizePrincipal(item, index));
    if (new Set(principals.map((item) => item.token)).size !== principals.length) throw new Error("gateway principal tokens must be unique");
    return principals;
  }
  const token = optionalEither(env, ["HIPER_AGENT_GATEWAY_TOKEN", "HIPER_AGENT_MEMORY_MCP_TOKEN"]);
  if (!token) return [];
  return [{
    id: "default",
    token,
    userId: required(env, "HIPER_USER_ID"),
    userKey: optional(env, "HIPER_USER_KEY"),
    defaultTeamId: optional(env, "HIPER_TEAM_ID"),
    defaultAgentId: optional(env, "HIPER_AGENT_ID"),
  }];
}

function normalizePrincipal(value: unknown, index: number): GatewayPrincipal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`principal ${index} must be an object`);
  const item = value as Record<string, unknown>;
  const text = (key: string, requiredValue = false) => {
    const result = typeof item[key] === "string" ? item[key].trim() : "";
    if (requiredValue && !result) throw new Error(`principal ${index}.${key} is required`);
    return result || undefined;
  };
  return { id: text("id") || `principal-${index + 1}`, token: text("token", true)!, userId: text("userId", true)!, userKey: text("userKey"), defaultTeamId: text("defaultTeamId"), defaultAgentId: text("defaultAgentId") };
}

function required(env: NodeJS.ProcessEnv, key: string): string { const value = optional(env, key); if (!value) throw new Error(`${key} is required`); return value; }
function optional(env: NodeJS.ProcessEnv, key: string): string | undefined { const value = env[key]?.trim(); return value || undefined; }
function optionalEither(env: NodeJS.ProcessEnv, keys: string[]): string | undefined { for (const key of keys) { const value = optional(env, key); if (value) return value; } return undefined; }
function integer(value: string | undefined, fallback: number): number { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
function split(value: string | undefined): string[] { return value ? [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))] : []; }
function decimal(value:string|undefined,fallback:number,min:number,max:number):number{const parsed=Number(value);return Number.isFinite(parsed)&&parsed>=min&&parsed<=max?parsed:fallback}
