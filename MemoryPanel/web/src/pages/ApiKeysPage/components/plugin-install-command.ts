export const CBRAIN_AGENT_INSTALLER_VERSION = '0.1.7';

export function buildCbrainAgentCommand(params: {
  action: 'install' | 'uninstall';
  client: 'codex' | 'claude-code';
  origin: string;
  gatewayUrl?: string;
}): string {
  const installerUrl = `"${params.origin.replace(/\/+$/, '')}/downloads/cbrain-agent.tgz?v=${CBRAIN_AGENT_INSTALLER_VERSION}"`;
  const prefix = `npx --yes --package ${installerUrl} cbrain-agent`;
  if (params.action === 'uninstall') return `${prefix} uninstall ${params.client}`;
  if (!params.gatewayUrl) throw new Error('gatewayUrl is required for install');
  return `${prefix} install ${params.client} --gateway ${params.gatewayUrl.replace(/\/+$/, '')}`;
}
