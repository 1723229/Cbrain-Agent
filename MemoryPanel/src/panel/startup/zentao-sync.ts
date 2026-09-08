import type { PanelDeps } from "../panel-deps.js";

export function startZentaoSync(deps: PanelDeps): () => void {
  if (!deps.config.zentao.enabled) return () => undefined;
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (const instance of deps.instanceRegistry.listAll()) {
        await deps.zentaoSyncService.scheduledSync(instance.instance_id, deps);
      }
    } catch (error) {
      deps.logger.warn("[zentao-sync] scheduled run skipped", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), deps.config.zentao.syncIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
