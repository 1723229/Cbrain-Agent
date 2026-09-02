import { getPanelSession } from './panelSession';

export interface PublicSkillItem {
  item_id: string;
  source_id: string;
  repo_path: string;
  name: string;
  description: string;
  layer: 'core' | 'extension';
  pack_key: string | null;
  category_path: string;
  partition_key: string;
  source_revision: string;
  content_hash: string;
  manifest: Array<{ path: string; size_bytes: number; mime_type: string; is_executable: boolean }>;
  total_bytes: number;
  updated_at: string;
}

export interface PublicSkillDocument {
  document_key: string;
  repo_path: string;
  title: string;
  content: string;
  source_revision: string;
  updated_at: string;
}

export interface PublicSkillTeamPolicy {
  team_id: string;
  pack_keys: string[];
  item_ids: string[];
  updated_by: string | null;
  updated_at: string | null;
}

export interface PublicSkillJob extends Record<string, unknown> {
  job_id: string;
  job_type: 'agent_init' | 'manual_pack';
  selection_key: string | null;
  status: string;
  total: number;
  succeeded: number;
  failed: number;
  items: Array<{
    item_id: string;
    name: string;
    status: string;
    attempts: number;
    last_error?: string;
  }>;
}

async function listAll(query: string): Promise<{ items: PublicSkillItem[]; total: number }> {
  const items: PublicSkillItem[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await call<{ items: PublicSkillItem[]; total: number }>('list', {
      query,
      limit: 500,
      offset,
    });
    items.push(...page.items);
    if (offset + page.items.length >= page.total || page.items.length === 0)
      return { items, total: page.total };
  }
}

export interface PublicSkillResource {
  path: string;
  content: string;
  encoding: 'base64';
  mime_type: string;
  is_executable: boolean;
}

export interface PublicSkillSnapshot extends PublicSkillItem {
  content: string;
  resources: PublicSkillResource[];
}

async function call<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const session = getPanelSession();
  const response = await fetch(`/api/v1/public-skills/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(session ? { 'X-Tdai-Service-Id': session.instanceId } : {}),
    },
    body: JSON.stringify(body),
  });
  const envelope = (await response.json()) as { code: number; message: string; data: T };
  if (!response.ok || envelope.code !== 0)
    throw new Error(envelope.message || 'Public Skill request failed');
  return envelope.data;
}

export const publicSkillApi = {
  status: () => call<Record<string, unknown>>('status'),
  list: (query = '') => listAll(query),
  documents: () => call<PublicSkillDocument[]>('documents'),
  get: (itemId: string, sourceRevision?: string) =>
    call<PublicSkillSnapshot>('get', {
      item_id: itemId,
      source_revision: sourceRevision,
    }),
  sync: () => call<Record<string, unknown>>('sync'),
  install: (item: PublicSkillItem, teamId: string, agentId: string) =>
    call<Record<string, unknown>>('install', {
      item_id: item.item_id,
      source_revision: item.source_revision,
      team_id: teamId,
      agent_id: agentId,
    }),
  installPack: (packKey: string, teamId: string, agentId: string) =>
    call<PublicSkillJob>('install-pack', {
      pack_key: packKey,
      team_id: teamId,
      agent_id: agentId,
    }),
  getPolicy: (teamId: string) => call<PublicSkillTeamPolicy>('policy/get', { team_id: teamId }),
  setPolicy: (teamId: string, packKeys: string[], itemIds: string[]) =>
    call<PublicSkillTeamPolicy>('policy/set', {
      team_id: teamId,
      pack_keys: packKeys,
      item_ids: itemIds,
    }),
  bootstrapStatus: (agentId: string) =>
    call<Record<string, unknown>>('bootstrap/status', { agent_id: agentId }),
  jobStatus: (jobId: string) => call<PublicSkillJob>('bootstrap/status', { job_id: jobId }),
  retryBootstrap: (jobId: string) => call<PublicSkillJob>('bootstrap/retry', { job_id: jobId }),
};
