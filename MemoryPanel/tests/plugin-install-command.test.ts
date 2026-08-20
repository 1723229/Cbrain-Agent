import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildCbrainAgentCommand,
  CBRAIN_AGENT_INSTALLER_VERSION,
} from '../web/src/pages/team/ApiKeysPage/components/plugin-install-command.js';

describe('Cbrain plugin install command', () => {
  it('uses the npm 10/11 compatible package form for install and uninstall', () => {
    expect(buildCbrainAgentCommand({
      action: 'install',
      client: 'claude-code',
      origin: 'http://10.0.0.50:8125/',
      gatewayUrl: 'http://10.0.0.50:8430/',
    })).toBe(
      'npx --yes --package "http://10.0.0.50:8125/downloads/cbrain-agent.tgz?v=0.1.6" cbrain-agent install claude-code --gateway http://10.0.0.50:8430',
    );
    expect(buildCbrainAgentCommand({
      action: 'uninstall',
      client: 'codex',
      origin: 'http://10.0.0.50:8125',
    })).toBe(
      'npx --yes --package "http://10.0.0.50:8125/downloads/cbrain-agent.tgz?v=0.1.6" cbrain-agent uninstall codex',
    );
  });

  it('keeps the page cache-buster aligned with the packaged installer version', async () => {
    const packageJson = JSON.parse(await readFile(
      resolve(process.cwd(), '../packages/cbrain-agent/package.json'),
      'utf8',
    )) as { version: string };

    expect(CBRAIN_AGENT_INSTALLER_VERSION).toBe(packageJson.version);
  });
});
