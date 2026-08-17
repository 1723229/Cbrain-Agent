import { describe, expect, it, vi } from 'vitest';

import { resolveWikiUploadLimits } from '../config.js';
import { createWikiRoutes } from './wiki.js';

const headers = { 'Content-Type': 'application/json', 'x-tdai-service-id': 'default' };

describe('Wiki raw upload limits', () => {
  it('defaults to 10 MiB per file with configurable request bounds', () => {
    expect(resolveWikiUploadLimits({})).toEqual({
      maxFileBytes: 10 * 1024 * 1024,
      maxFilesPerRequest: 10,
      maxTotalBytes: 50 * 1024 * 1024,
    });
  });

  it('accepts exactly 10 MiB and rejects one byte more at the HTTP boundary', async () => {
    const rawWriteMany = vi.fn((_serviceId, _teamId, _wikiId, files: Array<{ filename: string; content: string }>) =>
      files.map((file) => ({ filename: file.filename, size: Buffer.byteLength(file.content) })),
    );
    const app = createWikiRoutes({
      wikiService: { rawWriteMany } as never,
      wikiMgr: {} as never,
      publicBaseUrl: 'http://knowledge/v3',
      uploadLimits: resolveWikiUploadLimits({}),
    });
    const request = (content: string) => app.request('http://localhost/raw/write', {
      method: 'POST',
      headers,
      body: JSON.stringify({ team_id: 'team-12345678', wiki_id: 'wiki-12345678', files: [{ filename: 'large.md', content }] }),
    });

    const accepted = await request('a'.repeat(10 * 1024 * 1024));
    expect(accepted.status).toBe(200);
    expect(rawWriteMany).toHaveBeenCalledOnce();

    const rejected = await request('a'.repeat(10 * 1024 * 1024 + 1));
    expect(rejected.status).toBe(413);
    expect(rawWriteMany).toHaveBeenCalledOnce();
  });
});
