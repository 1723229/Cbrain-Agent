const RELOAD_MARKER = 'cbrain:chunk-load-reload-at';
const DEFAULT_RETRY_WINDOW_MS = 60_000;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function installChunkLoadRecovery(options: {
  target?: EventTarget;
  storage?: StorageLike;
  reload?: () => void;
  now?: () => number;
  retryWindowMs?: number;
} = {}): () => void {
  const target = options.target ?? window;
  const storage = options.storage ?? window.sessionStorage;
  const reload = options.reload ?? (() => window.location.reload());
  const now = options.now ?? Date.now;
  const retryWindowMs = options.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS;

  const handlePreloadError = (event: Event) => {
    const currentTime = now();
    let previousReload: number | null;
    try {
      const value = storage.getItem(RELOAD_MARKER);
      previousReload = value === null ? null : Number(value);
      if (previousReload !== null && Number.isFinite(previousReload)
        && currentTime - previousReload <= retryWindowMs) return;
      storage.setItem(RELOAD_MARKER, String(currentTime));
    } catch {
      // If session storage is unavailable, preserve the normal error boundary
      // instead of risking an uncontrolled reload loop.
      return;
    }
    event.preventDefault();
    reload();
  };

  target.addEventListener('vite:preloadError', handlePreloadError);
  return () => target.removeEventListener('vite:preloadError', handlePreloadError);
}
