import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Hono } from 'hono';

const INSTALLER_FILE = 'cbrain-agent.tgz';

export function registerPluginDownloadRoutes(app: Hono, downloadDir: string): void {
  app.get(`/downloads/${INSTALLER_FILE}`, async (c) => {
    try {
      const body = await readFile(path.join(downloadDir, INSTALLER_FILE));
      c.header('Cache-Control', 'no-store');
      c.header('Content-Disposition', `attachment; filename="${INSTALLER_FILE}"`);
      c.header('Content-Type', 'application/gzip');
      return c.body(new Uint8Array(body));
    } catch (error) {
      if (isMissingFile(error)) return c.notFound();
      throw error;
    }
  });
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
