import { describe, expect, it, vi } from 'vitest';

import { installChunkLoadRecovery } from '../web/src/lib/chunk-load-recovery.js';

describe('dynamic chunk load recovery', () => {
  it('reloads once and lets a repeated failure reach the error boundary', () => {
    const target = new EventTarget();
    const storage = memoryStorage();
    const reload = vi.fn();
    let currentTime = 1_000;
    installChunkLoadRecovery({
      target,
      storage,
      reload,
      now: () => currentTime,
      retryWindowMs: 60_000,
    });

    const first = new Event('vite:preloadError', { cancelable: true });
    target.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    const repeated = new Event('vite:preloadError', { cancelable: true });
    target.dispatchEvent(repeated);
    expect(repeated.defaultPrevented).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);

    currentTime += 60_001;
    const laterDeployment = new Event('vite:preloadError', { cancelable: true });
    target.dispatchEvent(laterDeployment);
    expect(laterDeployment.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}
