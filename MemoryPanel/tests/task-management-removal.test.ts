import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { buildPanelApp } from '../src/panel/http/app.js';
import type { Logger } from '../src/panel/infra/logger.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';

function noOpLogger(): Logger {
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return logger;
    },
  };
  return logger;
}

describe('task management removal', () => {
  it('does not expose the legacy Panel task aggregation endpoint', async () => {
    const invoke = vi.fn();
    const app = buildPanelApp({
      config: {
        ui: { distDir: '' },
        pluginDownloads: { dir: '' },
      },
      logger: noOpLogger(),
      metaKernel: { invoke },
    } as unknown as PanelDeps);

    const response = await app.request('/api/v1/task/list-with-agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: 'team-test' }),
    });

    expect(response.status).toBe(404);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps task UI and public task meta actions out after the upstream UI sync', async () => {
    const routes = readFileSync(path.resolve('web/src/routes/index.tsx'), 'utf8');
    const guide = readFileSync(path.resolve('web/src/pages/GuidePage/index.tsx'), 'utf8');
    const actions = await import('../src/panel/api/meta-actions.js');

    expect(routes).not.toContain('WorkbenchPage');
    expect(routes).toContain("path: 'tasks', element: <Navigate to=\"/team/agents\"");
    expect(guide).not.toMatch(/MemoryProxy|setup-proxy|Team→Agent→Task|OpenCode|OpenClaw|Hermes/);
    expect([...actions.ALLOWED_PANEL_ACTIONS].some((action) => action.startsWith('task'))).toBe(false);
  });
});
