import { describe, expect, it, vi } from 'vitest';

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
});
