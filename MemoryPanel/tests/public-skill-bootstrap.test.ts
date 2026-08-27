import { describe, expect, it, vi } from 'vitest';
import { enqueuePublicSkillsForAgent } from '../src/panel/services/default-agent-orchestrator.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { buildPanelApp } from '../src/panel/http/app.js';
import { InstanceRegistry } from '../src/panel/config/instance-registry.js';
import type { PublicSkillSnapshot } from '../src/panel/kernel/ports/knowledge-client-port.js';

describe('public Skill bootstrap', () => {
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
});
