import { describe, expect, it } from 'vitest';

import { parseConfig } from './config.js';

describe('LLM stream compatibility config', () => {
  it('defaults to non-streaming and accepts explicit stream overrides', () => {
    const defaults = parseConfig({});
    expect(defaults.llm?.stream ?? false).toBe(false);
    expect(defaults.offload.stream).toBe(false);

    const configured = parseConfig({
      llm: { enabled: true, apiKey: 'test-key', stream: true },
      offload: { stream: true },
    });
    expect(configured.llm?.stream).toBe(true);
    expect(configured.offload.stream).toBe(true);
  });
});
