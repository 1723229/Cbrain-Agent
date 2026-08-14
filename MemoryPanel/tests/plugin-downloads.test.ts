import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { registerPluginDownloadRoutes } from '../src/panel/http/routes/plugin-downloads.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('plugin download route', () => {
  it('serves only the packaged Cbrain installer', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cbrain-plugin-download-'));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, 'cbrain-agent.tgz'), 'installer');
    const app = new Hono();
    registerPluginDownloadRoutes(app, directory);

    const response = await app.request('/downloads/cbrain-agent.tgz');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/gzip');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('installer');
    expect((await app.request('/downloads/other.tgz')).status).toBe(404);
  });

  it('returns 404 before an installer is packaged', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cbrain-plugin-download-'));
    temporaryDirectories.push(directory);
    const app = new Hono();
    registerPluginDownloadRoutes(app, directory);

    expect((await app.request('/downloads/cbrain-agent.tgz')).status).toBe(404);
  });
});
