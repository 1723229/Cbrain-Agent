import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import type { ExternalTeamSyncSnapshot } from "../types.js";
import { MetadataService } from "./metadata-service.js";

describe("external team sync on SQLite", () => {
  let store: SqliteMetadataStore;
  let service: MetadataService;
  let adminId: string;
  let devId: string;

  beforeEach(async () => {
    store = new SqliteMetadataStore(":memory:");
    store.init();
    service = new MetadataService(store, "test");
    adminId = (await store.createUser({ username: "admin", auth_provider: "local", external_id: "admin", user_type: "system_admin" })).user_id;
    devId = (await store.createUser({ username: "dev", auth_provider: "ldap:zjyj", external_id: "dev", create_default_key: false })).user_id;
  });

  afterEach(() => store.close());

  function snapshot(status = "doing", members = ["dev"]): ExternalTeamSyncSnapshot {
    return {
      provider_id: "zentao:main",
      identity_provider_id: "ldap:zjyj",
      source_url: "https://zentao.example.test",
      captured_at: new Date().toISOString(),
      complete: true,
      projects: [{
        external_id: "1", name: "Project", code: "project", status,
        members: members.map((account) => ({ external_id: `1:${account}`, account, role: "member" as const })),
      }],
    };
  }

  it("首轮应用创建来源 Team、合并成员并保持幂等", async () => {
    const firstSnapshot = snapshot();
    const preview = await service.previewExternalTeamSync(firstSnapshot);
    const applied = await service.applyExternalTeamSync({
      snapshot: firstSnapshot,
      expected_snapshot_hash: preview.snapshot_hash,
      owner_user_id: adminId,
      trigger: "initial",
    });
    expect(applied.provisioning_candidates).toEqual([expect.objectContaining({ user_id: devId })]);
    const teams = await store.listTeams({ limit: 10, offset: 0 });
    expect(teams.items[0]).toMatchObject({ source_type: "zentao", source_ref: "1", status: "active" });
    expect((await store.getTeamMember(teams.items[0]!.team_id, devId))?.role).toBe("member");

    await store.updateTeamMemberProvisioning(teams.items[0]!.team_id, devId, "zentao", "success");
    const secondPreview = await service.previewExternalTeamSync(firstSnapshot);
    const second = await service.applyExternalTeamSync({
      snapshot: firstSnapshot,
      expected_snapshot_hash: secondPreview.snapshot_hash,
      owner_user_id: adminId,
      trigger: "scheduled",
    });
    expect(second.provisioning_candidates).toEqual([]);
    expect((await store.listTeams({ limit: 10, offset: 0 })).total).toBe(1);
  });

  it("撤销禅道来源时保留手工来源，关闭项目仅归档 Team", async () => {
    const initial = snapshot();
    const preview = await service.previewExternalTeamSync(initial);
    await service.applyExternalTeamSync({ snapshot: initial, expected_snapshot_hash: preview.snapshot_hash, owner_user_id: adminId, trigger: "initial" });
    const team = (await store.listTeams({ limit: 10, offset: 0 })).items[0]!;
    await expect(service.removeTeamMemberForCaller(team.team_id, devId, {
      token: "x", userId: adminId, isAdmin: false, isSystemAdmin: true,
    })).rejects.toMatchObject({ code: "member_managed_by_zentao" });

    await store.addTeamMember({ team_id: team.team_id, user_id: devId, role: "admin" });
    const closed = snapshot("closed", []);
    const closedPreview = await service.previewExternalTeamSync(closed);
    await service.applyExternalTeamSync({ snapshot: closed, expected_snapshot_hash: closedPreview.snapshot_hash, owner_user_id: adminId, trigger: "scheduled" });
    expect((await store.getTeamById(team.team_id))?.status).toBe("archived");
    expect((await store.getTeamMember(team.team_id, devId))?.role).toBe("admin");
  });

  it("拒绝过期预览和手工修改活跃禅道 Team", async () => {
    const initial = snapshot();
    await expect(service.applyExternalTeamSync({
      snapshot: initial, expected_snapshot_hash: "0".repeat(64), owner_user_id: adminId, trigger: "initial",
    })).rejects.toMatchObject({ code: "preview_stale" });

    const preview = await service.previewExternalTeamSync(initial);
    await service.applyExternalTeamSync({ snapshot: initial, expected_snapshot_hash: preview.snapshot_hash, owner_user_id: adminId, trigger: "initial" });
    const team = (await store.listTeams({ limit: 10, offset: 0 })).items[0]!;
    await expect(service.updateTeamForCaller(team.team_id, { name: "manual" }, {
      token: "x", userId: adminId, isAdmin: false, isSystemAdmin: true,
    })).rejects.toMatchObject({ code: "team_managed_by_zentao" });
    await expect(service.deleteTeamsForCaller([team.team_id], {
      token: "x", userId: adminId, isAdmin: false, isSystemAdmin: true,
    })).rejects.toMatchObject({ code: "team_managed_by_zentao" });
  });

  it("后台初始化默认 Agent 保持幂等且只允许有效成员", async () => {
    const initial = snapshot();
    const preview = await service.previewExternalTeamSync(initial);
    await service.applyExternalTeamSync({ snapshot: initial, expected_snapshot_hash: preview.snapshot_hash, owner_user_id: adminId, trigger: "initial" });
    const team = (await store.listTeams({ limit: 10, offset: 0 })).items[0]!;
    const input = {
      team_id: team.team_id, user_id: devId, name: "default-agent-dev",
      description: "default", prompt: "", visibility: "team" as const, metadata_json: "{}",
    };
    const first = await service.ensureDefaultAgentInternal(input);
    const second = await service.ensureDefaultAgentInternal(input);
    expect(second.agent_id).toBe(first.agent_id);
    expect((await store.listAgentsByTeam(team.team_id, { limit: 10, offset: 0 })).items).toHaveLength(1);
    await expect(service.ensureDefaultAgentInternal({ ...input, user_id: "usr-missing" }))
      .rejects.toMatchObject({ code: "member_not_found" });
  });
});
