/**
 * 默认 Agent 模板的本地文件存储（存 Panel 本地）。
 *
 * 路径：{dir}/{instanceId}/{team_id}/template.json
 * - 写入覆盖式 upsert（JSON 2 空格缩进）；
 * - 读取 ENOENT 返回 null（无模板）。
 * - team_id 做路径穿越防御。
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export interface AgentTemplateAssetIds {
  skills?: string[];
  code_graphs?: string[];
  wikis?: string[];
}

/** 模板配置（= JSON 文件内容，对齐 agent/create 入参）。 */
export interface AgentTemplateConfig {
  name: string;
  description?: string | null;
  prompt?: string | null;
  visibility?: string;
  metadata_json?: string;
  asset_ids?: AgentTemplateAssetIds;
}

export function parseAgentTemplate(value: unknown): AgentTemplateConfig | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 64) return null;
  const visibility = input.visibility;
  if (
    visibility !== undefined &&
    !["private", "team", "restricted"].includes(String(visibility))
  )
    return null;
  const rawAssets =
    input.asset_ids && typeof input.asset_ids === "object"
      ? (input.asset_ids as Record<string, unknown>)
      : {};
  const ids = (key: string): string[] | undefined => {
    const raw = rawAssets[key];
    if (raw === undefined) return undefined;
    if (
      !Array.isArray(raw) ||
      raw.some((item) => typeof item !== "string" || !item.trim())
    )
      return [];
    return [...new Set(raw.map((item) => String(item).trim()))];
  };
  const skills = ids("skills");
  const codeGraphs = ids("code_graphs");
  const wikis = ids("wikis");
  if (
    (rawAssets.skills !== undefined &&
      skills?.length === 0 &&
      (rawAssets.skills as unknown[]).length > 0) ||
    (rawAssets.code_graphs !== undefined &&
      codeGraphs?.length === 0 &&
      (rawAssets.code_graphs as unknown[]).length > 0) ||
    (rawAssets.wikis !== undefined &&
      wikis?.length === 0 &&
      (rawAssets.wikis as unknown[]).length > 0)
  )
    return null;
  return {
    name,
    description:
      typeof input.description === "string" ? input.description : null,
    prompt: typeof input.prompt === "string" ? input.prompt : null,
    visibility: typeof visibility === "string" ? visibility : "team",
    metadata_json:
      typeof input.metadata_json === "string" ? input.metadata_json : "{}",
    asset_ids: { skills, code_graphs: codeGraphs, wikis },
  };
}

function safeIdentifier(value: string, label: "instance" | "team"): string {
  if (
    !value ||
    value === "." ||
    value === ".." ||
    !/^[A-Za-z0-9._-]+$/.test(value)
  ) {
    throw new Error(`invalid ${label}_id for template path: ${value}`);
  }
  return value;
}

function templateFilePath(
  dir: string,
  instanceId: string,
  teamId: string,
): string {
  return path.join(dir, instanceId, teamId, "template.json");
}

export function saveAgentTemplate(
  dir: string,
  instanceId: string,
  teamId: string,
  config: AgentTemplateConfig,
): void {
  const filePath = templateFilePath(
    dir,
    safeIdentifier(instanceId, "instance"),
    safeIdentifier(teamId, "team"),
  );
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(config, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, filePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function getAgentTemplate(
  dir: string,
  instanceId: string,
  teamId: string,
): AgentTemplateConfig | null {
  const filePath = templateFilePath(
    dir,
    safeIdentifier(instanceId, "instance"),
    safeIdentifier(teamId, "team"),
  );
  try {
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw) as AgentTemplateConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

export function deleteAgentTemplate(
  dir: string,
  instanceId: string,
  teamId: string,
): void {
  const filePath = templateFilePath(
    dir,
    safeIdentifier(instanceId, "instance"),
    safeIdentifier(teamId, "team"),
  );
  rmSync(path.dirname(filePath), { recursive: true, force: true });
}
