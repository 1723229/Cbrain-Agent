import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { InstanceRegistry } from '../src/panel/config/instance-registry.js';
import { registerKnowledgeCodeGraphRoutes } from '../src/panel/http/routes/knowledge/code-graph-routes.js';
import type { Logger } from '../src/panel/infra/logger.js';
import type { KnowledgeClientPort, CodeGraphDetail } from '../src/panel/kernel/ports/knowledge-client-port.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';

const graph: CodeGraphDetail = {
  code_graph_id: 'cg-legacy',
  team_id: 'team-one',
  repo_name: 'group/repo',
  repo_url: 'http://gitlab.test/group/repo.git',
  branch: 'main',
  commit_hash: null,
  service_url: 'http://knowledge.test/v3/code-graph/cg-legacy',
  summary: null,
  status: 'ready',
  sync_error: null,
  version: '1',
  owner_user_id: 'usr-owner',
  stats: null,
  last_sync_at: null,
  created_at: '2026-08-20T00:00:00.000Z',
  updated_at: '2026-08-20T00:00:00.000Z',
};

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() { return this; },
};

function createDeps(options?: { member?: boolean; repairUnavailable?: boolean }) {
  const metaCalls: Array<{ action: string; body: Record<string, unknown> }> = [];
  const internalCalls: Array<{ path: string; body: unknown }> = [];
  const query = vi.fn(async () => ({ text: 'matched', isError: false }));
  const knowledge = {
    codeGraphCreate: vi.fn(async () => graph),
    codeGraphGet: vi.fn(async () => graph),
    codeGraphQuery: query,
  } as unknown as KnowledgeClientPort;

  const deps = {
    config: {
      metadataRemoteTimeoutMs: 1000,
      session: { cookieName: 'cbrain_session', secure: false, ttlSeconds: 3600 },
    },
    logger,
    instanceRegistry: new InstanceRegistry([{
      instance_id: 'default',
      name: 'Default',
      gateway_endpoint: 'http://core.test',
      api_key: 'internal-service-key',
    }]),
    authService: {
      async resolveSession() {
        return { user_id: 'usr-caller', username: 'caller', user_type: 'human', status: 'active' };
      },
    },
    metaKernel: {
      async invoke(action: string, body: Record<string, unknown>) {
        metaCalls.push({ action, body });
        if (action === 'team-member/get') {
          return options?.member === false
            ? { code: 404, message: 'not found', request_id: 'r', data: null }
            : { code: 0, message: 'ok', request_id: 'r', data: { status: 'active' } };
        }
        if (action === 'asset/get') {
          return { code: 404, message: 'not found', request_id: 'r', data: null };
        }
        if (action === 'asset/create') {
          return { code: 0, message: 'ok', request_id: 'r', data: { asset_id: body.asset_id } };
        }
        if (action === 'acl/check') {
          return { code: 0, message: 'ok', request_id: 'r', data: { allowed: true } };
        }
        throw new Error(`unexpected meta action: ${action}`);
      },
    },
    kernelHttp: {
      async postEnvelope(path: string, body: unknown) {
        internalCalls.push({ path, body });
        if (options?.repairUnavailable) throw new Error('core unavailable');
        return { code: 0, message: 'ok', request_id: 'r', data: { asset_id: graph.code_graph_id } };
      },
    },
    knowledgeClientFactory: () => knowledge,
  } as unknown as PanelDeps;
  return { deps, metaCalls, internalCalls, knowledge, query };
}

function request(app: Hono, path: string, body: Record<string, unknown>) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tdai-service-id': 'default',
      cookie: 'cbrain_session=session-token',
    },
    body: JSON.stringify(body),
  });
}

describe('CodeGraph asset lifecycle', () => {
  it('registers the meta asset immediately after creating the graph', async () => {
    const { deps, metaCalls } = createDeps();
    const app = new Hono();
    registerKnowledgeCodeGraphRoutes(app, deps);

    const response = await request(app, '/knowledge/code-graph/create', {
      team_id: graph.team_id,
      repo_url: graph.repo_url,
      branch: graph.branch,
    });

    expect(response.status).toBe(200);
    expect(metaCalls).toContainEqual({ action: 'asset/get', body: { asset_id: graph.code_graph_id } });
    expect(metaCalls).toContainEqual({
      action: 'asset/create',
      body: expect.objectContaining({
        asset_id: graph.code_graph_id,
        team_id: graph.team_id,
        asset_type: 'code_graph',
        owner_user_id: 'usr-caller',
      }),
    });
  });

  it('repairs a legacy KS-only graph before search and then applies ACL', async () => {
    const { deps, internalCalls, query } = createDeps();
    const app = new Hono();
    registerKnowledgeCodeGraphRoutes(app, deps);

    const response = await request(app, '/knowledge/code-graph/search', {
      code_graph_id: graph.code_graph_id,
      query: 'dao',
    });

    expect(response.status).toBe(200);
    expect(internalCalls).toEqual([{
      path: '/v3/internal/meta/asset/ensure-owned',
      body: expect.objectContaining({
        asset_id: graph.code_graph_id,
        team_id: graph.team_id,
        owner_user_id: graph.owner_user_id,
      }),
    }]);
    expect(query).toHaveBeenCalledWith(graph.code_graph_id, 'search', { query: 'dao' });
  });

  it('does not repair a graph for a caller outside its team', async () => {
    const { deps, internalCalls } = createDeps({ member: false });
    const app = new Hono();
    registerKnowledgeCodeGraphRoutes(app, deps);

    const response = await request(app, '/knowledge/code-graph/explore', {
      code_graph_id: graph.code_graph_id,
      query: 'architecture',
    });

    expect(response.status).toBe(403);
    expect(internalCalls).toHaveLength(0);
  });

  it('reports an upstream failure when the repair service is unavailable', async () => {
    const { deps, query } = createDeps({ repairUnavailable: true });
    const app = new Hono();
    registerKnowledgeCodeGraphRoutes(app, deps);

    const response = await request(app, '/knowledge/code-graph/search', {
      code_graph_id: graph.code_graph_id,
      query: 'dao',
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual(expect.objectContaining({ message: 'UPSTREAM_ERROR' }));
    expect(query).not.toHaveBeenCalled();
  });
});
