import type { PanelDeps } from "../panel-deps.js";
import type { MetaCallContext } from "../kernel/types.js";
import {
  getAgentTemplate,
  type AgentTemplateConfig,
} from "../state/agent-template-store.js";
import {
  fetchAllMetaListItems,
  resolveCallerUserId,
} from "../http/routes/knowledge/common.js";

const DEFAULT_AGENT_NAME = "default-agent";
const DEFAULT_AGENT_DESCRIPTION = "默认助手，可处理通用开发任务与日常协作。";
const DEFAULT_AGENT_METADATA_JSON = JSON.stringify({
  ui: { role_prompt: "", rules_prompt: "" },
});

interface TemplateSkillCandidate {
  skillId: string;
  name: string;
}

export function filterTemplateSkillsByPublicNames(
  candidates: TemplateSkillCandidate[],
  publicNames: ReadonlySet<string>,
): { keptSkillIds: string[]; skippedSkillIds: string[] } {
  const keptSkillIds: string[] = [];
  const skippedSkillIds: string[] = [];
  for (const candidate of candidates) {
    (publicNames.has(candidate.name) ? skippedSkillIds : keptSkillIds).push(
      candidate.skillId,
    );
  }
  return { keptSkillIds, skippedSkillIds };
}

export async function enqueuePublicSkillsForAgent(
  agent: { agent_id: string; team_id: string; owner_user_id: string },
  ctx: MetaCallContext,
  deps: PanelDeps,
): Promise<void> {
  try {
    await deps
      .knowledgeClientFactory(ctx.instanceId)
      .publicSkillBootstrapCreate({
        team_id: agent.team_id,
        agent_id: agent.agent_id,
        owner_user_id: agent.owner_user_id,
      });
  } catch (error) {
    deps.logger.warn("public skill bootstrap enqueue failed", {
      agentId: agent.agent_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function sanitizeTemplateForPublicSkills(
  template: AgentTemplateConfig,
  teamId: string,
  ctx: MetaCallContext,
  deps: PanelDeps,
): Promise<{ template: AgentTemplateConfig; skippedSkillIds: string[] }> {
  const skillIds = [...new Set(template.asset_ids?.skills ?? [])];
  if (skillIds.length === 0) return { template, skippedSkillIds: [] };

  let publicNames = new Set<string>();
  try {
    const client = deps.knowledgeClientFactory(ctx.instanceId);
    const names: string[] = [];
    for (let offset = 0; ; offset += 500) {
      const catalog = await client.publicSkillList("", 500, offset);
      names.push(...catalog.items.map((item) => item.name));
      if (offset + catalog.items.length >= catalog.total || catalog.items.length === 0) break;
    }
    publicNames = new Set(names);
  } catch {
    return { template, skippedSkillIds: [] };
  }

  const candidates: TemplateSkillCandidate[] = [];
  for (const skillId of skillIds) {
    const detail = await deps.skillKernel.invoke(
      "get",
      {
        user_id: ctx.userId,
        team_id: teamId,
        skill_id: skillId,
        include_content: false,
        include_manifest: false,
      },
      ctx,
    );
    if (detail.code !== 0) continue;
    const name = (detail.data as { name?: string } | null)?.name;
    if (name) candidates.push({ skillId, name });
  }

  const resolvedIds = new Set(candidates.map((candidate) => candidate.skillId));
  const unresolvedIds = skillIds.filter((skillId) => !resolvedIds.has(skillId));
  const filtered = filterTemplateSkillsByPublicNames(candidates, publicNames);
  return {
    template: {
      ...template,
      asset_ids: {
        ...template.asset_ids,
        skills: [...filtered.keptSkillIds, ...unresolvedIds],
      },
    },
    skippedSkillIds: filtered.skippedSkillIds,
  };
}

export async function ensureDefaultAgentForUser(
  input: { userId: string; teamId: string },
  ctx: MetaCallContext,
  deps: PanelDeps,
): Promise<void> {
  const template = getAgentTemplate(
    deps.config.agentTemplateDir,
    ctx.instanceId,
    input.teamId,
  );
  const userEnv = await deps.metaKernel.invoke(
    "user/get",
    { user_id: input.userId },
    ctx,
  );
  const username =
    userEnv.code === 0
      ? (userEnv.data as { username?: string } | null)?.username
      : undefined;
  const agentName =
    template?.name || `${DEFAULT_AGENT_NAME}-${username ?? input.userId}`;

  let agentListError: string | null = null;
  const agents = await fetchAllMetaListItems<{
    agent_id: string;
    name: string;
  }>(
    deps,
    ctx,
    "agent/list",
    { team_id: input.teamId, owner_user_id: input.userId, status: "active" },
    (envelope) => {
      agentListError = `${envelope.code} ${envelope.message}`;
    },
  );
  if (agentListError) throw new Error(`agent/list failed: ${agentListError}`);
  let agent = agents.find((candidate) => candidate.name === agentName);
  if (!agent) {
    const create = await deps.metaKernel.invoke(
      "agent/create",
      {
        team_id: input.teamId,
        owner_user_id: input.userId,
        name: agentName,
        description: template?.description ?? DEFAULT_AGENT_DESCRIPTION,
        prompt: template?.prompt ?? "",
        visibility: template?.visibility ?? "team",
        metadata_json: template?.metadata_json ?? DEFAULT_AGENT_METADATA_JSON,
        status: "active",
      },
      ctx,
    );
    if (create.code !== 0) {
      throw new Error(
        `create default agent failed: ${create.code} ${create.message}`,
      );
    }
    agent = {
      agent_id: (create.data as { agent_id: string }).agent_id,
      name: agentName,
    };
  }

  if (template) {
    const sanitized = await sanitizeTemplateForPublicSkills(
      template,
      input.teamId,
      ctx,
      deps,
    );
    await cloneTemplateAssets(
      deps,
      ctx,
      input.userId,
      input.teamId,
      sanitized.template,
      agent.agent_id,
    );
    if (sanitized.skippedSkillIds.length > 0) {
      deps.logger.info(
        "template Skills skipped because public catalog takes precedence",
        {
          teamId: input.teamId,
          agentId: agent.agent_id,
          skillIds: sanitized.skippedSkillIds,
        },
      );
    }
  }

  await enqueuePublicSkillsForAgent(
    {
      agent_id: agent.agent_id,
      team_id: input.teamId,
      owner_user_id: input.userId,
    },
    ctx,
    deps,
  );
}

async function cloneTemplateAssets(
  deps: PanelDeps,
  ctx: MetaCallContext,
  userId: string,
  teamId: string,
  template: AgentTemplateConfig,
  agentId: string,
): Promise<void> {
  for (const skillId of template.asset_ids?.skills ?? []) {
    try {
      await forkSkillToAgent(deps, ctx, userId, teamId, skillId, agentId);
    } catch (error) {
      deps.logger.warn("fork template skill failed", {
        instanceId: ctx.instanceId,
        skillId,
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const knowledgeIds = [
    ...(template.asset_ids?.code_graphs ?? []).map((assetId) => ({
      assetId,
      assetType: "code_graph",
    })),
    ...(template.asset_ids?.wikis ?? []).map((assetId) => ({
      assetId,
      assetType: "llm_wiki",
    })),
  ];
  for (const knowledge of knowledgeIds) {
    try {
      await allocateKnowledgeToAgent(
        deps,
        ctx,
        agentId,
        knowledge.assetId,
        knowledge.assetType,
      );
    } catch (error) {
      deps.logger.warn("allocate template knowledge failed", {
        instanceId: ctx.instanceId,
        assetId: knowledge.assetId,
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function forkSkillToAgent(
  deps: PanelDeps,
  ctx: MetaCallContext,
  userId: string,
  teamId: string,
  sourceSkillId: string,
  targetAgentId: string,
): Promise<void> {
  const get = await deps.skillKernel.invoke(
    "get",
    {
      user_id: userId,
      team_id: teamId,
      skill_id: sourceSkillId,
      include_content: true,
      include_manifest: true,
    },
    ctx,
  );
  if (get.code !== 0) throw new Error(`skill get failed: ${get.code}`);
  const detail = get.data as {
    name: string;
    content: string;
    manifest?: Array<{ path: string; is_executable?: boolean }>;
  };
  const resources: Array<{
    path: string;
    content: string;
    encoding: string;
    mime_type?: string;
    is_executable?: boolean;
  }> = [];
  for (const entry of detail.manifest ?? []) {
    const file = await deps.skillKernel.invoke(
      "files/read",
      {
        user_id: userId,
        team_id: teamId,
        skill_id: sourceSkillId,
        path: entry.path,
      },
      ctx,
    );
    if (file.code !== 0) continue;
    const data = file.data as {
      path: string;
      content: string;
      encoding: string;
      mime_type?: string;
    };
    resources.push({ ...data, is_executable: entry.is_executable });
  }
  const create = await deps.skillKernel.invoke(
    "create",
    {
      user_id: userId,
      team_id: teamId,
      agent_id: targetAgentId,
      name: detail.name,
      content: detail.content,
      resources: resources.length ? resources : undefined,
      metadata: { forked_from: { skill_id: sourceSkillId, name: detail.name } },
    },
    ctx,
  );
  if (create.code !== 0 && create.code !== 42201) {
    throw new Error(`skill create failed: ${create.code}`);
  }
}

async function allocateKnowledgeToAgent(
  deps: PanelDeps,
  ctx: MetaCallContext,
  agentId: string,
  assetId: string,
  assetType: string,
): Promise<void> {
  const caller = await resolveCallerUserId(deps, ctx);
  let listError: string | null = null;
  const bindings = await fetchAllMetaListItems<{
    asset_id: string;
    asset_type: string;
    injection_mode?: string;
    priority?: number;
    created_by?: string;
  }>(deps, ctx, "agent-fixed-asset/list", { agent_id: agentId }, (envelope) => {
    listError = `${envelope.code} ${envelope.message}`;
  });
  if (listError) throw new Error(`agent-fixed-asset/list failed: ${listError}`);
  if (bindings.some((binding) => binding.asset_id === assetId)) return;

  const set = await deps.metaKernel.invoke(
    "agent-fixed-asset/set",
    {
      agent_id: agentId,
      bindings: [
        ...bindings.map((binding) => ({
          asset_id: binding.asset_id,
          asset_type: binding.asset_type,
          injection_mode: binding.injection_mode ?? "summary",
          priority: binding.priority ?? 50,
          created_by: binding.created_by,
        })),
        {
          asset_id: assetId,
          asset_type: assetType,
          injection_mode: "tool",
          priority: 50,
          created_by: caller,
        },
      ],
    },
    ctx,
  );
  if (set.code !== 0)
    throw new Error(`agent-fixed-asset/set failed: ${set.code}`);
}
