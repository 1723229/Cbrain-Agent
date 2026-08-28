import { describe, expect, it } from 'vitest';

import { enUS } from '../web/src/i18n/en-US.js';
import { zhCN } from '../web/src/i18n/zh-CN.js';

describe('user-facing Cbrain copy', () => {
  it('uses the Cbrain brand in onboarding', () => {
    expect(zhCN['onboarding.guide.start.admin.title']).toBe('欢迎使用 Cbrain');
    expect(zhCN['onboarding.guide.start.member.title']).toBe('欢迎使用 Cbrain');
    expect(enUS['onboarding.guide.start.admin.title']).toBe('Welcome to Cbrain');
    expect(enUS['onboarding.guide.start.member.title']).toBe('Welcome to Cbrain');
  });

  it('describes the supported coding-agent integrations', () => {
    expect(zhCN['apiKey.desc']).toContain('Codex / Claude Code Plugin');
    expect(zhCN['onboarding.guide.apikey.desc']).toContain('Codex / Claude Code Plugin');
    expect(enUS['apiKey.desc']).toContain('Codex / Claude Code Plugin');
    expect(enUS['onboarding.guide.apikey.desc']).toContain('Codex / Claude Code Plugin');
  });

  it('does not promise removed task management from the member page', () => {
    expect(zhCN['member.subtitle']).not.toContain('task');
    expect(enUS['member.subtitle']).not.toContain('task');
  });

  it('separates platform usage from coding-client setup without credential ambiguity', () => {
    expect(zhCN['guide.platform.title']).toBe('平台使用说明');
    expect(zhCN['guide.client.title']).toBe('客户端接入指南');
    expect(zhCN['guide.platform.login.desc']).toContain('LDAP');
    expect(zhCN['guide.platform.login.desc']).toContain('Web Session');
    expect(zhCN['guide.platform.login.desc']).toContain('应急登录');
    expect(zhCN['guide.client.apiKey.desc']).toContain('插件客户端');
    expect(zhCN['guide.client.apiKey.desc']).toContain('仅用于连接 Cbrain Gateway');
    expect(zhCN['guide.client.binding.desc']).toContain('唯一候选自动绑定');
    expect(zhCN['guide.client.binding.desc']).toContain('多个候选');

    expect(enUS['guide.platform.title']).toBe('Platform Guide');
    expect(enUS['guide.client.title']).toBe('Client Integration Guide');
    expect(enUS['guide.client.apiKey.desc']).toContain('plugin client');
    expect(enUS['guide.client.binding.desc']).toContain('auto-binds');
  });

  it('does not retain the replaced brand or legacy client names', () => {
    const visibleCopy = [...Object.values(zhCN), ...Object.values(enUS)].join('\n');

    expect(visibleCopy).not.toContain('TDAI Panel');
    expect(visibleCopy).not.toContain('TDAI 面板');
    expect(visibleCopy).not.toContain('CodeBuddy / ClaudeCode CLI');
  });
});
