import { describe, expect, it, vi } from 'vitest';

import type { StorageAdapter } from '../../core/storage/adapter.js';
import { createStorageTools } from './storage-tools.js';

describe('storage-backed LLM edit tool', () => {
  it('inserts JavaScript replacement tokens literally instead of expanding them', async () => {
    let content = 'before TARGET after';
    const storage = {
      readFile: vi.fn(async () => content),
      writeFile: vi.fn(async (_key: string, value: string) => { content = value; }),
    } as unknown as StorageAdapter;
    const tools = createStorageTools(storage, 'scene/');

    const result = await (tools.edit as unknown as {
      execute(args: { path: string; edits: Array<{ oldText: string; newText: string }> }): Promise<string>;
    }).execute({
      path: 'one.md',
      edits: [{ oldText: 'TARGET', newText: '$& $1 $` $\' $$' }],
    });

    expect(JSON.parse(result)).toEqual({ success: true });
    expect(content).toBe('before $& $1 $` $\' $$ after');
  });
});
