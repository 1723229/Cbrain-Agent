import type { Hono } from 'hono';
import type { Context } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { buildCtx, canManageTeam, canReadTeam, readJson, str, strArray, okEnvelope } from './knowledge/common.js';
import { respondControlError, respondEnvelope } from '../envelope.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';

export function registerPublicSkillRoutes(api: Hono, deps: PanelDeps): void {
  api.use('/public-skills/*', validatePanelMetaHeaders(deps));
  api.post('/public-skills/status', async (c) => run(c, () => deps.knowledgeClientFactory(buildCtx(c).instanceId).publicSkillStatus()));
  api.post('/public-skills/list', async (c) => {
    const body = await readJson(c); const client = deps.knowledgeClientFactory(buildCtx(c).instanceId);
    return run(c, () => client.publicSkillList(str(body, 'query') ?? '', number(body.limit, 100), number(body.offset, 0)));
  });
  api.post('/public-skills/documents', async (c) => run(c, () =>
    deps.knowledgeClientFactory(buildCtx(c).instanceId).publicSkillDocuments()));
  api.post('/public-skills/get', async (c) => {
    const body = await readJson(c); const itemId = str(body, 'item_id');
    if (!itemId) return respondControlError(c, 400, 'MISSING_ITEM_ID');
    return run(c, () => deps.knowledgeClientFactory(buildCtx(c).instanceId)
      .publicSkillSnapshot(itemId, str(body, 'source_revision') || undefined));
  });
  api.post('/public-skills/sync', async (c) => {
    const meta = c.get('panelMeta');
    if (meta.user.user_type !== 'system_admin') return respondControlError(c, 403, 'SYSTEM_ADMIN_REQUIRED');
    return run(c, () => deps.knowledgeClientFactory(buildCtx(c).instanceId).publicSkillSync());
  });
  api.post('/public-skills/install', async (c) => {
    const body = await readJson(c); const ctx = buildCtx(c);
    const itemId = str(body, 'item_id'), teamId = str(body, 'team_id'), agentId = str(body, 'agent_id');
    if (!itemId || !teamId || !agentId || !ctx.userId) return respondControlError(c, 400, 'MISSING_INSTALL_CONTEXT');
    const gate = await agentInstallAccess(deps, ctx, c.get('panelMeta').user, teamId, agentId);
    if (!gate) return respondControlError(c, 403, 'AGENT_INSTALL_FORBIDDEN');
    try {
      const snapshot = await deps.knowledgeClientFactory(ctx.instanceId).publicSkillSnapshot(itemId, str(body, 'source_revision') || undefined);
      const env = await deps.skillKernel.invoke('snapshot/apply', {
        user_id: gate.ownerUserId, team_id: teamId, agent_id: agentId, name: snapshot.name,
        content: snapshot.content, resources: snapshot.resources,
        metadata: { catalog_origin: origin(snapshot) },
      }, ctx);
      return respondEnvelope(c, env);
    } catch { return respondControlError(c, 502, 'PUBLIC_SKILL_INSTALL_FAILED'); }
  });
  api.post('/public-skills/install-pack', async (c) => {
    const body = await readJson(c); const ctx = buildCtx(c);
    const packKey = str(body, 'pack_key'), teamId = str(body, 'team_id'), agentId = str(body, 'agent_id');
    if (!packKey || !teamId || !agentId || !ctx.userId) return respondControlError(c, 400, 'MISSING_INSTALL_CONTEXT');
    const gate = await agentInstallAccess(deps, ctx, c.get('panelMeta').user, teamId, agentId);
    if (!gate) return respondControlError(c, 403, 'AGENT_INSTALL_FORBIDDEN');
    return run(c, () => deps.knowledgeClientFactory(ctx.instanceId).publicSkillPackInstallCreate({
      team_id: teamId, agent_id: agentId, owner_user_id: gate.ownerUserId, pack_key: packKey,
    }));
  });
  api.post('/public-skills/policy/get', async (c) => {
    const body = await readJson(c); const ctx = buildCtx(c); const teamId = str(body, 'team_id');
    if (!teamId || !ctx.userId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!await canReadTeam(deps, ctx, c.get('panelMeta').user, teamId)) return respondControlError(c, 403, 'NOT_TEAM_MEMBER');
    return run(c, () => deps.knowledgeClientFactory(ctx.instanceId).publicSkillPolicyGet(teamId));
  });
  api.post('/public-skills/policy/set', async (c) => {
    const body = await readJson(c); const ctx = buildCtx(c); const teamId = str(body, 'team_id');
    if (!teamId || !ctx.userId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!await canManageTeam(deps, ctx, c.get('panelMeta').user, teamId)) return respondControlError(c, 403, 'TEAM_ADMIN_REQUIRED');
    return run(c, () => deps.knowledgeClientFactory(ctx.instanceId).publicSkillPolicySet({
      team_id: teamId, pack_keys: strArray(body, 'pack_keys'), item_ids: strArray(body, 'item_ids'), updated_by: ctx.userId!,
    }));
  });
  api.post('/public-skills/bootstrap/status', async (c) => {
    const body = await readJson(c); const ctx = buildCtx(c);
    try {
      const result = await deps.knowledgeClientFactory(ctx.instanceId).publicSkillBootstrapStatus({ job_id: str(body, 'job_id') || undefined, agent_id: str(body, 'agent_id') || undefined });
      if (!await agentInstallAccess(deps, ctx, c.get('panelMeta').user, String(result.team_id ?? ''), String(result.agent_id ?? ''))) return respondControlError(c, 403, 'AGENT_INSTALL_FORBIDDEN');
      return respondEnvelope(c, okEnvelope(c, result));
    } catch { return respondControlError(c, 404, 'BOOTSTRAP_JOB_NOT_FOUND'); }
  });
  api.post('/public-skills/bootstrap/retry', async (c) => {
    const body = await readJson(c); const jobId = str(body, 'job_id');
    if (!jobId) return respondControlError(c, 400, 'MISSING_JOB_ID');
    const ctx = buildCtx(c); const client = deps.knowledgeClientFactory(ctx.instanceId);
    try {
      const existing = await client.publicSkillBootstrapStatus({ job_id: jobId });
      if (!await agentInstallAccess(deps, ctx, c.get('panelMeta').user, String(existing.team_id ?? ''), String(existing.agent_id ?? ''))) return respondControlError(c, 403, 'AGENT_INSTALL_FORBIDDEN');
      return respondEnvelope(c, okEnvelope(c, await client.publicSkillBootstrapRetry(jobId)));
    } catch { return respondControlError(c, 404, 'BOOTSTRAP_JOB_NOT_FOUND'); }
  });
}

async function agentInstallAccess(
  deps: PanelDeps,
  ctx: ReturnType<typeof buildCtx>,
  user: { user_id: string; user_type?: string },
  teamId: string,
  agentId: string,
): Promise<{ ownerUserId: string } | null> {
  const env = await deps.metaKernel.invoke('agent/get', { agent_id: agentId }, ctx);
  const agent = env.data as { team_id?: string; owner_user_id?: string; status?: string } | null;
  if (env.code !== 0 || agent?.team_id !== teamId || !agent.owner_user_id || agent.status === 'inactive') return null;
  if (agent.owner_user_id === ctx.userId || await canManageTeam(deps, ctx, user, teamId)) return { ownerUserId: agent.owner_user_id };
  return null;
}

function origin(snapshot: { source_id: string; item_id: string; repo_path: string; source_revision: string; content_hash: string }) {
  return { source_id: snapshot.source_id, item_id: snapshot.item_id, repo_path: snapshot.repo_path,
    source_revision: snapshot.source_revision, content_hash: snapshot.content_hash };
}
function number(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
async function run(c: Context, fn: () => Promise<unknown>) { try { return respondEnvelope(c, okEnvelope(c, await fn())); } catch { return respondControlError(c, 502, 'PUBLIC_SKILL_UPSTREAM_ERROR'); } }
