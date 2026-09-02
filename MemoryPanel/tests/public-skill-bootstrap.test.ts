import { describe, expect, it, vi } from 'vitest';
import { enqueuePublicSkillsForAgent } from '../src/panel/services/default-agent-orchestrator.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { buildPanelApp } from '../src/panel/http/app.js';
import { InstanceRegistry } from '../src/panel/config/instance-registry.js';
import type { PublicSkillSnapshot } from '../src/panel/kernel/ports/knowledge-client-port.js';
import { shouldRefreshBindingsAfterBootstrap } from '../web/src/components/team/public-skill-bootstrap-state.js';

describe('public Skill bootstrap', () => {
  it('refreshes Agent bindings when an asynchronous install reaches a terminal state', () => {
    expect(shouldRefreshBindingsAfterBootstrap('running', 'completed')).toBe(true);
    expect(shouldRefreshBindingsAfterBootstrap('pending', 'partial')).toBe(true);
    expect(shouldRefreshBindingsAfterBootstrap('', 'completed')).toBe(false);
    expect(shouldRefreshBindingsAfterBootstrap('completed', 'completed')).toBe(false);
  });
  it('requires a valid Panel session for public catalog APIs', async () => {
    const deps = {
      config: { ui: { distDir: '' }, pluginDownloads: { dir: '' }, session: { cookieName: 'cbrain_session' } },
      instanceRegistry: new InstanceRegistry([{ instance_id: 'default', name: 'Default', gateway_endpoint: 'http://core', api_key: 'service' }]),
      authService: { resolveSession: vi.fn() },
      logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
    } as unknown as PanelDeps;
    const response = await buildPanelApp(deps).request('/api/v1/public-skills/status', {
      method: 'POST', headers: { 'x-tdai-service-id': 'default', 'content-type': 'application/json' }, body: '{}',
    });
    expect(response.status).toBe(401);
  });

  it('returns a revision-pinned full snapshot for public Skill details', async () => {
    const snapshot: PublicSkillSnapshot = {
      item_id: 'pub-code-review',
      source_id: 'shared-skills',
      repo_path: 'skills/code-review',
      name: 'code-review',
      description: 'Review code changes',
      source_revision: 'abc123',
      content_hash: 'hash-1',
      manifest: [{ path: 'references/checklist.md', size_bytes: 12, mime_type: 'text/markdown', is_executable: false }],
      total_bytes: 12,
      updated_at: '2026-08-26T00:00:00.000Z',
      content: '---\nname: code-review\ndescription: Review code changes\n---\n\n# Code Review',
      resources: [{ path: 'references/checklist.md', content: 'IyBDaGVja2xpc3Q=', encoding: 'base64', mime_type: 'text/markdown', is_executable: false }],
    };
    const getSnapshot = vi.fn(async () => snapshot);
    const deps = {
      config: { ui: { distDir: '' }, pluginDownloads: { dir: '' }, session: { cookieName: 'cbrain_session' } },
      instanceRegistry: new InstanceRegistry([{ instance_id: 'default', name: 'Default', gateway_endpoint: 'http://core', api_key: 'service' }]),
      authService: { resolveSession: vi.fn(async () => ({ user_id: 'usr-1', username: 'user', user_type: 'human', status: 'active' })) },
      knowledgeClientFactory: () => ({ publicSkillSnapshot: getSnapshot }),
      logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
    } as unknown as PanelDeps;

    const response = await buildPanelApp(deps).request('/api/v1/public-skills/get', {
      method: 'POST',
      headers: {
        'x-tdai-service-id': 'default',
        'content-type': 'application/json',
        cookie: 'cbrain_session=session-token',
      },
      body: JSON.stringify({ item_id: snapshot.item_id, source_revision: snapshot.source_revision }),
    });

    expect(response.status).toBe(200);
    expect(getSnapshot).toHaveBeenCalledWith(snapshot.item_id, snapshot.source_revision);
    const envelope = await response.json() as { data: PublicSkillSnapshot };
    expect(envelope.data.content).toContain('# Code Review');
    expect(envelope.data.resources).toEqual(snapshot.resources);
  });

  it('enqueues all public Skills after an Agent is created', async () => {
    const create = vi.fn(async () => ({ job_id: 'job-1' }));
    const deps = {
      knowledgeClientFactory: () => ({ publicSkillBootstrapCreate: create }),
      logger: { warn: vi.fn() },
    } as unknown as PanelDeps;

    await enqueuePublicSkillsForAgent(
      { agent_id: 'agent-1', team_id: 'team-1', owner_user_id: 'user-1' },
      { instanceId: 'default', gatewayEndpoint: 'http://core', gatewayApiKey: 'service' },
      deps,
    );

    expect(create).toHaveBeenCalledWith({ team_id: 'team-1', agent_id: 'agent-1', owner_user_id: 'user-1' });
  });

  it('keeps Agent creation successful when enqueue fails', async () => {
    const warn = vi.fn();
    const deps = {
      knowledgeClientFactory: () => ({ publicSkillBootstrapCreate: async () => { throw new Error('catalog down'); } }),
      logger: { warn },
    } as unknown as PanelDeps;
    await expect(enqueuePublicSkillsForAgent(
      { agent_id: 'agent-1', team_id: 'team-1', owner_user_id: 'user-1' },
      { instanceId: 'default', gatewayEndpoint: 'http://core', gatewayApiKey: 'service' }, deps,
    )).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('allows a Team admin to install a public Skill for another owner Agent', async () => {
    const apply = vi.fn(async () => ({ code: 0, message: 'ok', data: { skill_id: 'skl-1' } }));
    const snapshot = {
      item_id: 'pub-1', source_id: 'shared-skills', repo_path: 'core/grill-me', name: 'grill-me',
      description: 'Clarify plans', layer: 'core' as const, pack_key: null, category_path: 'core', partition_key: 'core',
      source_revision: 'rev-1', content_hash: 'hash-1', manifest: [], total_bytes: 0,
      updated_at: '2026-09-03T00:00:00.000Z', content: '---\nname: grill-me\ndescription: Clarify plans\n---\n', resources: [],
    };
    const deps = panelDeps({
      metaInvoke: async (action) => {
        if (action === 'agent/get') return { code: 0, data: { team_id: 'team-1', owner_user_id: 'owner-1', status: 'active' } };
        if (action === 'team/get') return { code: 0, data: { owner_user_id: 'owner-2' } };
        if (action === 'team-member/get') return { code: 0, data: { role: 'admin', status: 'active' } };
        throw new Error(action);
      },
      knowledge: { publicSkillSnapshot: async () => snapshot },
      skillInvoke: apply,
    });

    const response = await buildPanelApp(deps).request('/api/v1/public-skills/install', panelRequest({
      item_id: 'pub-1', source_revision: 'rev-1', team_id: 'team-1', agent_id: 'agent-1',
    }));

    expect(response.status).toBe(200);
    expect(apply).toHaveBeenCalledWith('snapshot/apply', expect.objectContaining({
      user_id: 'owner-1', team_id: 'team-1', agent_id: 'agent-1', name: 'grill-me',
    }), expect.anything());
  });

  it('prevents a normal member from installing to another owner Agent', async () => {
    const apply = vi.fn();
    const deps = panelDeps({
      metaInvoke: async (action) => {
        if (action === 'agent/get') return { code: 0, data: { team_id: 'team-1', owner_user_id: 'owner-1', status: 'active' } };
        if (action === 'team/get') return { code: 0, data: { owner_user_id: 'owner-2' } };
        if (action === 'team-member/get') return { code: 0, data: { role: 'member', status: 'active' } };
        throw new Error(action);
      },
      knowledge: {}, skillInvoke: apply,
    });

    const response = await buildPanelApp(deps).request('/api/v1/public-skills/install', panelRequest({
      item_id: 'pub-1', team_id: 'team-1', agent_id: 'agent-1',
    }));

    expect(response.status).toBe(403);
    expect(apply).not.toHaveBeenCalled();
  });

  it('allows a Team admin to save future-Agent extension defaults', async () => {
    const setPolicy = vi.fn(async () => ({ team_id: 'team-1', pack_keys: ['aps'], item_ids: [] }));
    const deps = panelDeps({
      metaInvoke: async (action) => {
        if (action === 'team/get') return { code: 0, data: { owner_user_id: 'owner-2' } };
        if (action === 'team-member/get') return { code: 0, data: { role: 'admin', status: 'active' } };
        throw new Error(action);
      },
      knowledge: { publicSkillPolicySet: setPolicy }, skillInvoke: vi.fn(),
    });

    const response = await buildPanelApp(deps).request('/api/v1/public-skills/policy/set', panelRequest({
      team_id: 'team-1', pack_keys: ['aps'], item_ids: [],
    }));

    expect(response.status).toBe(200);
    expect(setPolicy).toHaveBeenCalledWith({ team_id: 'team-1', pack_keys: ['aps'], item_ids: [], updated_by: 'usr-1' });
  });

  it('creates a pack job with the target Agent owner identity', async () => {
    const createPack = vi.fn(async () => ({ job_id: 'pack-1', status: 'pending' }));
    const deps = panelDeps({
      metaInvoke: async (action) => {
        if (action === 'agent/get') return { code: 0, data: { team_id: 'team-1', owner_user_id: 'owner-1', status: 'active' } };
        if (action === 'team/get') return { code: 0, data: { owner_user_id: 'owner-2' } };
        if (action === 'team-member/get') return { code: 0, data: { role: 'admin', status: 'active' } };
        throw new Error(action);
      },
      knowledge: { publicSkillPackInstallCreate: createPack }, skillInvoke: vi.fn(),
    });

    const response = await buildPanelApp(deps).request('/api/v1/public-skills/install-pack', panelRequest({
      team_id: 'team-1', agent_id: 'agent-1', pack_key: 'aps',
    }));

    expect(response.status).toBe(200);
    expect(createPack).toHaveBeenCalledWith({ team_id: 'team-1', agent_id: 'agent-1', owner_user_id: 'owner-1', pack_key: 'aps' });
  });

  it('allows ordinary members to install only to their own active Agent', async () => {
    const apply = vi.fn(async () => ({ code: 0, message: 'ok', data: { skill_id: 'skl-1' } }));
    const snapshot = {
      item_id: 'pub-1', source_id: 'shared-skills', repo_path: 'core/grill-me', name: 'grill-me',
      source_revision: 'rev-1', content_hash: 'hash', content: '---\nname: grill-me\ndescription: x\n---\n', resources: [],
    };
    const deps = panelDeps({
      metaInvoke: async (action) => {
        if (action === 'agent/get') return { code: 0, data: { team_id: 'team-1', owner_user_id: 'usr-1', status: 'active' } };
        throw new Error(action);
      }, knowledge: { publicSkillSnapshot: async () => snapshot }, skillInvoke: apply,
    });

    const response = await buildPanelApp(deps).request('/api/v1/public-skills/install', panelRequest({
      item_id: 'pub-1', team_id: 'team-1', agent_id: 'agent-1',
    }));
    expect(response.status).toBe(200);
    expect(apply).toHaveBeenCalledOnce();
  });

  it('denies Team policy reads to users outside the Team', async () => {
    const getPolicy = vi.fn();
    const deps = panelDeps({
      metaInvoke: async (action) => {
        if (action === 'team/get') return { code: 0, data: { owner_user_id: 'owner-2' } };
        if (action === 'team-member/get') return { code: 404, data: null };
        throw new Error(action);
      }, knowledge: { publicSkillPolicyGet: getPolicy }, skillInvoke: vi.fn(),
    });

    const response = await buildPanelApp(deps).request('/api/v1/public-skills/policy/get', panelRequest({ team_id: 'team-1' }));
    expect(response.status).toBe(403);
    expect(getPolicy).not.toHaveBeenCalled();
  });
});

function panelDeps(options: {
  metaInvoke(action: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  knowledge: Record<string, unknown>;
  skillInvoke: ReturnType<typeof vi.fn>;
}): PanelDeps {
  return {
    config: { ui: { distDir: '' }, pluginDownloads: { dir: '' }, session: { cookieName: 'cbrain_session' } },
    instanceRegistry: new InstanceRegistry([{ instance_id: 'default', name: 'Default', gateway_endpoint: 'http://core', api_key: 'service' }]),
    authService: { resolveSession: vi.fn(async () => ({ user_id: 'usr-1', username: 'user', user_type: 'human', status: 'active' })) },
    knowledgeClientFactory: () => options.knowledge,
    metaKernel: { invoke: vi.fn(options.metaInvoke) },
    skillKernel: { invoke: options.skillInvoke },
    logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
  } as unknown as PanelDeps;
}

function panelRequest(body: Record<string, unknown>): RequestInit {
  return { method: 'POST', headers: {
    'x-tdai-service-id': 'default', 'content-type': 'application/json', cookie: 'cbrain_session=session-token',
  }, body: JSON.stringify(body) };
}
