import { describe, expect, it } from 'vitest';

import { normalizeLlmConfig } from './llm.js';

describe('Wiki LLM stream compatibility config', () => {
  it('is disabled by default and preserved when enabled', () => {
    expect(normalizeLlmConfig({ apiKey: 'x' }).stream).toBe(false);
    expect(normalizeLlmConfig({ apiKey: 'x', stream: true }).stream).toBe(true);
  });
});
