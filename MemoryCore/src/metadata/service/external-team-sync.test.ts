import { describe, expect, it } from "vitest";
import type {
  ExternalTeamSyncSnapshot,
  TeamEntity,
  TeamMemberSourceEntity,
  UserEntity,
} from "../types.js";
import { buildExternalTeamSyncPreview } from "./external-team-sync.js";

const NOW = "2026-09-08T00:00:00.000Z";

function user(user_id: string, username: string, status: UserEntity["status"] = "active"): UserEntity {
  return {
    user_id,
    username,
    status,
    auth_provider: "ldap:zjyj",
    external_id: username,
    user_type: "normal",
    raw_profile_json: "{}",
    created_at: NOW,
    updated_at: NOW,
    metadata_json: "{}",
  };
}

function snapshot(): ExternalTeamSyncSnapshot {
  return {
    provider_id: "zentao:main",
    identity_provider_id: "ldap:zjyj",
    source_url: "https://zentao.example.test",
    captured_at: NOW,
    complete: true,
    projects: [
      {
        external_id: "11",
        name: "APS",
        code: "aps",
        status: "doing",
        pm_account: "pm",
        members: [
          { external_id: "11:dev", account: "dev", role: "member" },
          { external_id: "11:pm", account: "pm", role: "member" },
          { external_id: "11:missing", account: "missing", role: "member" },
        ],
      },
    ],
  };
}

describe("buildExternalTeamSyncPreview", () => {
  it("按 LDAP provider 精确匹配账号，并把 PM 独立提升为 admin", () => {
    const preview = buildExternalTeamSyncPreview({
      snapshot: snapshot(),
      users: [user("usr-dev", "dev"), user("usr-pm", "pm"), { ...user("usr-other", "dev"), auth_provider: "local" }],
      teams: [],
      memberSources: [],
    });

    expect(preview.counts).toMatchObject({ teams_create: 1, members_add: 2, unresolved_users: 1 });
    expect(preview.projects[0]?.members).toEqual([
      expect.objectContaining({ user_id: "usr-dev", role: "member" }),
      expect.objectContaining({ user_id: "usr-pm", role: "admin" }),
    ]);
    expect(preview.issues).toEqual([{ code: "USER_NOT_FOUND", project_ref: "11", account: "missing" }]);
  });

  it("不创建首次出现的关闭项目，并识别已有项目的关闭与重开", () => {
    const existing: TeamEntity = {
      team_id: "team-aps",
      name: "APS",
      owner_user_id: "usr-admin",
      description: null,
      status: "active",
      source_type: "zentao",
      source_ref: "11",
      source_url: "https://zentao.example.test",
      created_at: NOW,
      updated_at: NOW,
      metadata_json: "{}",
    };
    const closed = snapshot();
    closed.projects[0]!.status = "closed";
    closed.projects.push({ external_id: "12", name: "Closed", code: "closed", status: "closed", members: [] });

    const closePreview = buildExternalTeamSyncPreview({ snapshot: closed, users: [], teams: [existing], memberSources: [] });
    expect(closePreview.counts.teams_inactivate).toBe(1);
    expect(closePreview.counts.teams_create).toBe(0);
    expect(closePreview.projects.map((p) => p.external_id)).toEqual(["11"]);

    const archived = { ...existing, status: "archived" as const };
    const reopenPreview = buildExternalTeamSyncPreview({ snapshot: snapshot(), users: [], teams: [archived], memberSources: [] });
    expect(reopenPreview.counts.teams_reactivate).toBe(1);
  });

  it("基于禅道来源计算成员增删，保留手工来源且快照哈希稳定", () => {
    const existing: TeamEntity = {
      team_id: "team-aps",
      name: "Old APS",
      owner_user_id: "usr-admin",
      description: null,
      status: "active",
      source_type: "zentao",
      source_ref: "11",
      source_url: null,
      created_at: NOW,
      updated_at: NOW,
      metadata_json: "{}",
    };
    const source = (user_id: string, source_type: TeamMemberSourceEntity["source_type"]): TeamMemberSourceEntity => ({
      id: `${source_type}-${user_id}`,
      team_id: existing.team_id,
      user_id,
      source_type,
      source_ref: source_type === "zentao" ? `11:${user_id}` : "manual",
      role: "member",
      status: "active",
      last_seen_at: NOW,
      provisioning_status: "success",
      provisioning_error: null,
      created_at: NOW,
      updated_at: NOW,
      metadata_json: "{}",
    });
    const args = {
      snapshot: snapshot(),
      users: [user("usr-dev", "dev"), user("usr-pm", "pm")],
      teams: [existing],
      memberSources: [source("usr-old", "zentao"), source("usr-manual", "manual")],
    };
    const first = buildExternalTeamSyncPreview(args);
    const second = buildExternalTeamSyncPreview({ ...args, users: [...args.users].reverse() });

    expect(first.counts).toMatchObject({ teams_update: 1, members_add: 2, members_remove: 1 });
    expect(first.snapshot_hash).toBe(second.snapshot_hash);
  });

  it("重复 LDAP 账号或非 active 账号均不自动绑定", () => {
    const preview = buildExternalTeamSyncPreview({
      snapshot: snapshot(),
      users: [user("usr-a", "dev"), user("usr-b", "dev"), user("usr-pm", "pm", "inactive")],
      teams: [],
      memberSources: [],
    });
    expect(preview.issues).toEqual(expect.arrayContaining([
      { code: "USER_AMBIGUOUS", project_ref: "11", account: "dev" },
      { code: "USER_INACTIVE", project_ref: "11", account: "pm" },
    ]));
  });

  it("同名旧身份 inactive、新身份 active 时选择唯一 active 用户", () => {
    const preview = buildExternalTeamSyncPreview({
      snapshot: snapshot(),
      users: [
        user("usr-dev-old", "dev", "inactive"),
        user("usr-dev-new", "dev", "active"),
        user("usr-pm", "pm"),
      ],
      teams: [],
      memberSources: [],
    });

    expect(preview.projects[0]?.members).toContainEqual(
      expect.objectContaining({ user_id: "usr-dev-new", account: "dev" }),
    );
    expect(preview.issues).not.toContainEqual(
      expect.objectContaining({ account: "dev" }),
    );
  });

  it("完整快照中消失的已同步项目会进入停用预览", () => {
    const existing: TeamEntity = {
      team_id: "team-missing", name: "Missing", owner_user_id: "usr-admin",
      description: null, status: "active", source_type: "zentao", source_ref: "99",
      source_url: null, created_at: NOW, updated_at: NOW, metadata_json: "{}",
    };
    const empty = snapshot();
    empty.projects = [];
    const preview = buildExternalTeamSyncPreview({
      snapshot: empty,
      users: [],
      teams: [existing],
      memberSources: [{
        id: "src-1", team_id: existing.team_id, user_id: "usr-old", source_type: "zentao",
        source_ref: "99:old", role: "member", status: "active", last_seen_at: NOW,
        provisioning_status: "success", provisioning_error: null, created_at: NOW,
        updated_at: NOW, metadata_json: "{}",
      }],
    });
    expect(preview.counts).toMatchObject({ teams_inactivate: 1, members_remove: 1 });
  });
});
