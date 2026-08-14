import type { PanelDeps } from '../panel-deps.js';

export function startLdapSync(deps: PanelDeps): () => void {
  if (!deps.config.ldap.enabled) return () => undefined;
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await deps.authService.syncLdapUsers();
      deps.logger.info('[ldap-sync] complete', result);
    } catch (err) {
      // 查询或调用链任一步失败都不提交不完整快照，Core 不会误停用用户。
      deps.logger.warn('[ldap-sync] skipped', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), deps.config.ldap.syncIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
