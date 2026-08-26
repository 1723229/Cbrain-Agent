import { getPanelSession } from './panelSession';

export interface PublicSkillItem {
  item_id: string; source_id: string; repo_path: string; name: string; description: string;
  source_revision: string; content_hash: string;
  manifest: Array<{ path: string; size_bytes: number; mime_type: string; is_executable: boolean }>;
  total_bytes: number; updated_at: string;
}

export interface PublicSkillResource {
  path: string; content: string; encoding: 'base64'; mime_type: string; is_executable: boolean;
}

export interface PublicSkillSnapshot extends PublicSkillItem {
  content: string;
  resources: PublicSkillResource[];
}

async function call<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const session = getPanelSession();
  const response = await fetch(`/api/v1/public-skills/${action}`, { method: 'POST', headers: {
    'content-type': 'application/json', ...(session ? { 'X-Tdai-Service-Id': session.instanceId } : {}),
  }, body: JSON.stringify(body) });
  const envelope = await response.json() as { code: number; message: string; data: T };
  if (!response.ok || envelope.code !== 0) throw new Error(envelope.message || 'Public Skill request failed');
  return envelope.data;
}

export const publicSkillApi = {
  status: () => call<Record<string, unknown>>('status'),
  list: (query = '') => call<{ items: PublicSkillItem[]; total: number }>('list', { query, limit: 500 }),
  get: (itemId: string, sourceRevision?: string) => call<PublicSkillSnapshot>('get', {
    item_id: itemId, source_revision: sourceRevision,
  }),
  sync: () => call<Record<string, unknown>>('sync'),
  install: (item: PublicSkillItem, teamId: string, agentId: string) => call<Record<string, unknown>>('install', {
    item_id: item.item_id, source_revision: item.source_revision, team_id: teamId, agent_id: agentId,
  }),
  bootstrapStatus: (agentId: string) => call<Record<string, unknown>>('bootstrap/status', { agent_id: agentId }),
  retryBootstrap: (jobId: string) => call<Record<string, unknown>>('bootstrap/retry', { job_id: jobId }),
};
