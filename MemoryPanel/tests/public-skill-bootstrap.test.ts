import { describe, expect, it, vi } from 'vitest';
import { enqueuePublicSkillsForAgent } from '../src/panel/http/routes/meta/proxy.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { buildPanelApp } from '../src/panel/http/app.js';
import { InstanceRegistry } from '../src/panel/config/instance-registry.js';

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
