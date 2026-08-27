import { config as loadDotenv } from "dotenv";
import type { LogLevel } from "../infra/logger.js";

loadDotenv();

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export interface PanelConfig {
  server: { host: string; port: number };
  metadataInstancesConfig: string;
  metadataRemoteTimeoutMs: number;
  ui: { distDir: string };
  pluginDownloads: { dir: string };
  log: { level: LogLevel; format: "json" | "pretty" };
  /** Knowledge Service (KS :8421) 连接配置。serviceId 按请求 instanceId 注入。 */
  knowledge: { baseUrl: string; authToken: string; timeoutMs: number };
  wikiUpload: WikiUploadLimits;
  /**
   * 启动时为每个实例确保 knowledge-service LLM 绑定（走 proxy 记账）。
   * sync=false 时完全跳过（不改变现有部署行为）。
   */
  knowledgeLlmBinding: {
    sync: boolean;
    proxyBaseUrl: string;
  };
  ldap: {
    enabled: boolean;
    providerId: string;
    url: string;
    userBaseDn: string;
    bindDn: string;
    bindPasswordFile: string;
    startTls: boolean;
    caFile: string;
    allowInsecurePoc: boolean;
    connectTimeoutMs: number;
    operationTimeoutMs: number;
    syncIntervalMs: number;
  };
  session: {
    cookieName: string;
    secure: boolean;
    ttlSeconds: number;
  };
  /** 默认 Agent 模板目录；组合部署默认落在 Hub 持久化数据卷。 */
  agentTemplateDir: string;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

export function loadPanelConfig(): PanelConfig {
  const level = env("LOG_LEVEL", "info") as LogLevel;
  const format = env("LOG_FORMAT", "json") as "json" | "pretty";
  return {
    server: {
      host: env("HOST", "0.0.0.0"),
      port: envInt("PORT", 8123),
    },
    metadataInstancesConfig: env(
      "METADATA_INSTANCES_CONFIG",
      "./config/metadata-instances.json",
    ),
    metadataRemoteTimeoutMs: envInt("METADATA_REMOTE_TIMEOUT_MS", 15_000),
    ui: { distDir: env("UI_DIST_DIR", "./web/dist") },
    pluginDownloads: { dir: env("CBRAIN_PLUGIN_DOWNLOAD_DIR", "./downloads") },
    log: {
      level: ["debug", "info", "warn", "error"].includes(level)
        ? level
        : "info",
      format: format === "pretty" ? "pretty" : "json",
    },
    knowledge: {
      baseUrl: env("KNOWLEDGE_SERVICE_URL", "http://127.0.0.1:8421"),
      authToken: env("KNOWLEDGE_AUTH_TOKEN", ""),
      timeoutMs: envInt("KNOWLEDGE_TIMEOUT_MS", 15_000),
    },
    wikiUpload: resolveWikiUploadLimits(),
    knowledgeLlmBinding: {
      sync: envBool("KNOWLEDGE_LLM_BINDING_SYNC", true),
      proxyBaseUrl: env(
        "KNOWLEDGE_LLM_PROXY_BASE_URL",
        "http://127.0.0.1:8096",
      ),
    },
    ldap: {
      enabled: envBool("CBRAIN_LDAP_ENABLED", false),
      providerId: env("CBRAIN_LDAP_PROVIDER_ID", "ldap:giga"),
      url: env("CBRAIN_LDAP_URL", "ldap://127.0.0.1:389"),
      userBaseDn: env(
        "CBRAIN_LDAP_USER_BASE_DN",
        "ou=people,dc=giga,dc=internal",
      ),
      bindDn: env("CBRAIN_LDAP_BIND_DN", ""),
      bindPasswordFile: env("CBRAIN_LDAP_BIND_PASSWORD_FILE", ""),
      startTls: envBool("CBRAIN_LDAP_STARTTLS", true),
      caFile: env("CBRAIN_LDAP_CA_FILE", ""),
      allowInsecurePoc: envBool("CBRAIN_LDAP_ALLOW_INSECURE_POC", false),
      connectTimeoutMs: envInt("CBRAIN_LDAP_CONNECT_TIMEOUT_MS", 3_000),
      operationTimeoutMs: envInt("CBRAIN_LDAP_OPERATION_TIMEOUT_MS", 5_000),
      syncIntervalMs: envInt("CBRAIN_LDAP_SYNC_INTERVAL_MS", 5 * 60_000),
    },
    session: {
      cookieName: env("CBRAIN_SESSION_COOKIE_NAME", "cbrain_session"),
      secure: envBool("CBRAIN_SESSION_COOKIE_SECURE", true),
      ttlSeconds: envInt("CBRAIN_SESSION_TTL_SECONDS", 12 * 60 * 60),
    },
    agentTemplateDir: env(
      "TDAI_AGENT_TEMPLATE_DIR",
      "/data/knowledge/agent-templates",
    ),
  };
}

export interface WikiUploadLimits {
  maxFileBytes: number;
  maxFilesPerRequest: number;
  maxTotalBytes: number;
}

export function resolveWikiUploadLimits(
  source: NodeJS.ProcessEnv = process.env,
): WikiUploadLimits {
  const positiveInt = (key: string, fallback: number): number => {
    const raw = source[key];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  };
  return {
    maxFileBytes: positiveInt(
      "CBRAIN_WIKI_UPLOAD_MAX_FILE_BYTES",
      10 * 1024 * 1024,
    ),
    maxFilesPerRequest: positiveInt("CBRAIN_WIKI_UPLOAD_MAX_FILES", 10),
    maxTotalBytes: positiveInt(
      "CBRAIN_WIKI_UPLOAD_MAX_TOTAL_BYTES",
      50 * 1024 * 1024,
    ),
  };
}
