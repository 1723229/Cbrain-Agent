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

  it('documents the complete platform onboarding and public Skill lifecycle', () => {
    expect(zhCN['guide.roles.systemAdmin.desc']).toContain('只有系统管理员可以新建 Team');
    expect(zhCN['guide.roles.teamAdmin.desc']).toContain('已有 LDAP 用户');
    expect(zhCN['guide.defaultAgent.trigger.desc']).toContain('加入 Team');
    expect(zhCN['guide.defaultAgent.backfill.desc']).toContain('不会自动补建');
    expect(zhCN['guide.publicSkill.core.desc']).toContain('6 个');
    expect(zhCN['guide.publicSkill.policy.desc']).toContain('只影响后续创建的 Agent');
    expect(zhCN['guide.publicSkill.existing.desc']).toContain('已有 Agent');
    expect(zhCN['guide.publicSkill.conflict.desc']).toContain('公共 Skill 优先');
    expect(zhCN['guide.operations.apiKey.desc']).toContain('创建、查看和撤销');
    expect(zhCN['guide.operations.delete.desc']).toContain('不可恢复');
    expect(zhCN['guide.operations.wikiMcp.desc']).toContain('/mcp/wiki');

    expect(enUS['guide.roles.systemAdmin.desc']).toContain('Only system administrators');
    expect(enUS['guide.defaultAgent.backfill.desc']).toContain('not backfilled');
    expect(enUS['guide.publicSkill.policy.desc']).toContain('future Agents');
    expect(enUS['guide.operations.wikiMcp.desc']).toContain('/mcp/wiki');
  });

  it('documents install, upgrade, uninstall, and workspace binding behavior', () => {
    expect(zhCN['guide.client.install.desc']).toContain('首次安装');
    expect(zhCN['guide.client.upgrade.desc']).toContain('保留');
    expect(zhCN['guide.client.uninstall.desc']).toContain('服务端数据');
    expect(zhCN['guide.client.binding.reuse']).toContain('自动复用');
    expect(zhCN['guide.client.binding.change']).toContain('改绑');

    expect(enUS['guide.client.uninstall.desc']).toContain('server-side data');
    expect(enUS['guide.client.binding.change']).toContain('rebind');
  });

  it('keeps every in-product guide key available in both languages', () => {
    const zhGuideKeys = Object.keys(zhCN).filter((key) => key.startsWith('guide.')).sort();
    const enGuideKeys = Object.keys(enUS).filter((key) => key.startsWith('guide.')).sort();
    expect(enGuideKeys).toEqual(zhGuideKeys);
  });

  it('does not retain the replaced brand or legacy client names', () => {
    const visibleCopy = [...Object.values(zhCN), ...Object.values(enUS)].join('\n');

    expect(visibleCopy).not.toContain('TDAI Panel');
    expect(visibleCopy).not.toContain('TDAI 面板');
    expect(visibleCopy).not.toContain('CodeBuddy / ClaudeCode CLI');
  });
});
