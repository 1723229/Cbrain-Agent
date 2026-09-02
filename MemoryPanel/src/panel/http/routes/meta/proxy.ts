import type { Hono } from "hono";
import type { MetaAction } from "../../../api/meta-actions.js";
import {
  ALLOWED_PANEL_ACTIONS,
  isNotInScopeAction,
} from "../../../api/meta-actions.js";
import type { PanelDeps } from "../../../panel-deps.js";
import { validatePanelMetaHeaders } from "../../middleware/validate-panel-headers.js";
import { respondControlError, respondEnvelope } from "../../envelope.js";
import type { MetaCallContext } from "../../../kernel/types.js";
import { KNOWLEDGE_SERVICE_USERNAME } from "../../../startup/ensure-knowledge-llm-binding.js";
import {
  deleteAgentTemplate,
  getAgentTemplate as readTemplateFile,
  parseAgentTemplate,
  saveAgentTemplate as writeTemplateFile,
} from "../../../state/agent-template-store.js";
import {
  enqueuePublicSkillsForAgent,
  ensureDefaultAgentForUser,
  sanitizeTemplateForPublicSkills,
} from "../../../services/default-agent-orchestrator.js";
import { canManageTeam } from "../knowledge/common.js";

/**
 * Hide the internal per-instance `knowledge-service` billing user from panel user
 * listings (design 009 §4.2). Mutates the envelope's paginated `items`/`total` in place.
 */
function hideKnowledgeServiceUser(data: unknown): void {
  if (!data || typeof data !== "object") return;
  const d = data as { items?: Array<{ username?: string }>; total?: number };
  if (!Array.isArray(d.items)) return;
  const before = d.items.length;
  d.items = d.items.filter((u) => u.username !== KNOWLEDGE_SERVICE_USERNAME);
  const removed = before - d.items.length;
  if (removed > 0 && typeof d.total === "number") {
    d.total = Math.max(0, d.total - removed);
  }
}

function readAction(path: string): string {
  const marker = "/meta/";
  const idx = path.indexOf(marker);
  if (idx < 0) return "";
  return path.slice(idx + marker.length);
}

// ── 创建时重复名称检查 ──

interface DupCheckConfig {
  /** 用来查重的 list action。 */
  listAction: string;
  /** 从 create body 构造 list 请求体（限定可见范围）。 */
  listBody: (body: Record<string, unknown>) => Record<string, unknown>;
  /** 内核新增的精确过滤参数名。 */
  filterParam: string;
  /** 从 create body 提取待匹配的值。 */
  matchValue: (body: Record<string, unknown>) => string | undefined;
  /** 中文实体名，用于错误消息。 */
  entityLabel: string;
}

const DUP_CHECK_MAP: Record<string, DupCheckConfig> = {
  "user/create": {
    listAction: "user/list",
    listBody: () => ({}),
    filterParam: "username",
    matchValue: (b) =>
      typeof b.username === "string" ? b.username : undefined,
    entityLabel: "用户",
  },
  // user/create 的姊妹接口：查重口径与 user/create 完全一致（先按 username 精确 list）。
  // user_key 的重复由内核 duplicate_user_key(409) 兜底，Panel 直接透传。
  "user/create-with-key": {
    listAction: "user/list",
    listBody: () => ({}),
    filterParam: "username",
    matchValue: (b) =>
      typeof b.username === "string" ? b.username : undefined,
    entityLabel: "用户",
  },
  "team/create": {
    listAction: "team/list",
    listBody: (b) => ({ user_id: b.owner_user_id }),
    filterParam: "name",
    matchValue: (b) => (typeof b.name === "string" ? b.name : undefined),
    entityLabel: "团队",
  },
  "agent/create": {
    listAction: "agent/list",
    // 面板「删除」走 agent/archive（status→inactive），列表只展示 active；
    // 查重须同样过滤，否则归档后同名重建会被误拦 409。
    listBody: (b) => ({
      team_id: b.team_id,
      owner_user_id: b.owner_user_id,
      status: "active",
    }),
    filterParam: "name",
    matchValue: (b) => (typeof b.name === "string" ? b.name : undefined),
    entityLabel: "Agent",
  },
};

/**
 * 对 create 类 action 做"先查后写"重复检查。
 * 返回 null 表示不重复；否则返回中文错误消息。
 */
async function checkDuplicate(
  action: string,
  body: Record<string, unknown>,
  ctx: MetaCallContext,
  deps: PanelDeps,
): Promise<string | null> {
  const config = DUP_CHECK_MAP[action];
  if (!config) return null;

  const targetValue = config.matchValue(body);
  if (!targetValue) return null;

  const listBody = {
    ...config.listBody(body),
    [config.filterParam]: targetValue,
    limit: 1,
  };

  try {
    const envelope = await deps.metaKernel.invoke(
      config.listAction,
      listBody,
      ctx,
    );
    if (envelope.code === 0) {
      // 以返回 items 中的精确同名为准；部分内核版本可能暂不支持 name 过滤，
      // 不能因为 items 非空就误判重复。
      const data = envelope.data as { items?: unknown[] } | undefined;
      if (Array.isArray(data?.items)) {
        const duplicated = data.items.some((item) => {
          if (!item || typeof item !== "object") return false;
          const value = (item as Record<string, unknown>)[config.filterParam];
          return typeof value === "string" && value === targetValue;
        });
        if (duplicated) {
          return `已存在同名${config.entityLabel}「${targetValue}」，请更换名称后重试。`;
        }
      }
    }
  } catch {
    // 查重失败时放行，宁可允许重复也不错杀正常创建
  }
  return null;
}

// ── 路由注册 ──

export function registerMetaProxyRoutes(api: Hono, deps: PanelDeps): void {
  api.post("/meta/*", validatePanelMetaHeaders(deps), async (c) => {
    const action = readAction(c.req.path);
    if (!action) {
      return respondControlError(c, 404, "UNKNOWN_META_ACTION");
    }

    if (isNotInScopeAction(action)) {
      return respondControlError(c, 501, "NOT_IN_SCOPE");
    }

    if (!ALLOWED_PANEL_ACTIONS.has(action as MetaAction)) {
      return respondControlError(c, 404, "UNKNOWN_META_ACTION");
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const panelMeta = c.get("panelMeta");
    const ctx: MetaCallContext = {
      instanceId: panelMeta.instanceId,
      gatewayEndpoint: panelMeta.gatewayEndpoint,
      gatewayApiKey: panelMeta.gatewayApiKey,
      userKey: panelMeta.userKey,
      userId: panelMeta.user.user_id,
      reqId: c.get("reqId"),
    };

    // create 类 action：先查重
    const duplicateMsg = await checkDuplicate(action, body, ctx, deps);
    if (duplicateMsg) {
      return respondControlError(c, 409, duplicateMsg);
    }

    // ── 默认 Agent 模板读写：Panel 直接读写本地文件（不转发内核）──
    if (action === "agent/set-default-template") {
      const teamId = typeof body.team_id === "string" ? body.team_id : "";
      const template = parseAgentTemplate(body.template);
      if (!teamId || !template) {
        return respondControlError(c, 400, "INVALID_PARAM");
      }
      if (!(await canManageTeam(deps, ctx, panelMeta.user, teamId))) {
        return respondControlError(c, 403, "permission_denied");
      }
      const sanitized = await sanitizeTemplateForPublicSkills(
        template,
        teamId,
        ctx,
        deps,
      );
      writeTemplateFile(
        deps.config.agentTemplateDir,
        ctx.instanceId,
        teamId,
        sanitized.template,
      );
      return respondEnvelope(c, {
        code: 0,
        message: "ok",
        request_id: ctx.reqId ?? "",
        data: {
          ok: true,
          template: sanitized.template,
          skipped_skill_ids: sanitized.skippedSkillIds,
        },
      });
    }
    if (action === "agent/get-default-template") {
      const teamId = typeof body.team_id === "string" ? body.team_id : "";
      const template = teamId
        ? readTemplateFile(deps.config.agentTemplateDir, ctx.instanceId, teamId)
        : null;
      return respondEnvelope(c, {
        code: 0,
        message: "ok",
        request_id: ctx.reqId ?? "",
        data: template ?? {},
      });
    }

    const envelope = await deps.metaKernel.invoke(action, body, ctx);
    // team-member/add 成功后，为默认 Agent 复制模板资产（best-effort，异步不阻塞响应）
    if (action === "team-member/add" && envelope.code === 0) {
      const userId = typeof body.user_id === "string" ? body.user_id : "";
      const teamId = typeof body.team_id === "string" ? body.team_id : "";
      if (userId && teamId) {
        void ensureDefaultAgentForUser({ userId, teamId }, ctx, deps).catch(
          (error) => {
            deps.logger.warn("default Agent orchestration failed", {
              userId,
              teamId,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        );
      }
    }
    if (action === "team/create" && envelope.code === 0) {
      const team = envelope.data as {
        team_id?: string;
        owner_user_id?: string;
      } | null;
      if (team?.team_id && team.owner_user_id) {
        void ensureDefaultAgentForUser(
          { teamId: team.team_id, userId: team.owner_user_id },
          ctx,
          deps,
        ).catch((error) => {
          deps.logger.warn("team owner default Agent orchestration failed", {
            userId: team.owner_user_id,
            teamId: team.team_id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
    if (action === "agent/create" && envelope.code === 0) {
      const agent = envelope.data as {
        agent_id?: string;
        team_id?: string;
        owner_user_id?: string;
      } | null;
      if (agent?.agent_id && agent.team_id && agent.owner_user_id) {
        await enqueuePublicSkillsForAgent(
          {
            agent_id: agent.agent_id,
            team_id: agent.team_id,
            owner_user_id: agent.owner_user_id,
          },
          ctx,
          deps,
        );
      }
    }
    if (action === "team/delete" && envelope.code === 0) {
      const teamIds = Array.isArray(body.team_ids)
        ? body.team_ids.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      for (const teamId of teamIds) {
        deleteAgentTemplate(
          deps.config.agentTemplateDir,
          ctx.instanceId,
          teamId,
        );
      }
    }

    if (action.startsWith("user-key/")) c.header("Cache-Control", "no-store");
    if (action === "user/list" && envelope.code === 0) {
      hideKnowledgeServiceUser(envelope.data);
    }
    // 切私密后：不再由 backend 主动 prune 其它 agent 的绑定。
    // 内核权限模型下 caller 只能 set 自己 owner 的 agent，跨 owner 会 403。
    // 保留脏 binding 也无害：injection / memory-bridge / 面板详情页在读侧调
    // apply_visibility_filter=true 过滤掉 canBindAsset=false 的项。
    return respondEnvelope(c, envelope);
  });
}
