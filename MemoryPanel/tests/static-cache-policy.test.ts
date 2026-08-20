import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildPanelApp } from '../src/panel/http/app.js';
import type { Logger } from '../src/panel/infra/logger.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Panel static cache policy', () => {
  it('does not cache HTML and caches hashed assets immutably', async () => {
    const app = await staticApp();

    const index = await app.request('/');
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(index.headers.get('cache-control')).toBe('no-store');

    const asset = await app.request('/assets/main-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('returns 404 instead of the SPA document for a missing asset', async () => {
    const app = await staticApp();

    const response = await app.request('/assets/removed-chunk.js');

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).not.toContain('text/html');
    expect(await response.text()).not.toContain('<div id="root">');
  });
});

async function staticApp() {
  const distDir = await mkdtemp(path.join(tmpdir(), 'cbrain-static-'));
  temporaryDirectories.push(distDir);
  await mkdir(path.join(distDir, 'assets'));
  await writeFile(path.join(distDir, 'index.html'), '<div id="root"></div>');
  await writeFile(path.join(distDir, 'assets', 'main-abc123.js'), 'export const ready = true;');

  return buildPanelApp({
    config: {
      ui: { distDir },
      pluginDownloads: { dir: '' },
    },
    logger: noOpLogger(),
  } as unknown as PanelDeps);
}

function noOpLogger(): Logger {
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() { return logger; },
  };
  return logger;
}
