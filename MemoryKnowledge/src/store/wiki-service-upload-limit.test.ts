import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { IKnowledgeStore } from './types.js';
import { WikiService } from './wiki-service.js';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('WikiService raw source limit', () => {
  it('persists a 10 MiB source and rejects a larger source', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'cbrain-wiki-upload-'));
    temporaryDirectories.push(dataRoot);
    const store = {
      getWiki: () => ({ status: 'ready' }),
    } as unknown as IKnowledgeStore;
    const service = new WikiService({
      store,
      dataRoot,
      worker: async () => undefined,
      rawWriteMaxBytes: 10 * 1024 * 1024,
    });
    const content = 'a'.repeat(10 * 1024 * 1024);

    expect(service.rawWrite('default', 'team-12345678', 'wiki-12345678', 'large.md', content)).toEqual({
      filename: 'large.md',
      size: content.length,
    });
    expect(readFileSync(join(dataRoot, 'default', 'team-12345678', 'wiki-12345678', 'raw', 'sources', 'large.md'), 'utf8')).toHaveLength(content.length);
    expect(service.rawWrite('default', 'team-12345678', 'wiki-12345678', 'too-large.md', `${content}a`)).toBe('too_large');
  });
});
