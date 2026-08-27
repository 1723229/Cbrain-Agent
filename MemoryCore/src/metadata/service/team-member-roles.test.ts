import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { V3AuthContext } from "../router/auth.js";
import { V3_ROUTES } from "../router/v3-meta-router.js";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { MetadataService } from "./metadata-service.js";

describe("team member role management", () => {
  let store: SqliteMetadataStore;
  let service: MetadataService;

  beforeEach(() => {
    store = new SqliteMetadataStore(":memory:");
    store.init();
    service = new MetadataService(store, "one");
  });

  afterEach(() => store.close());

  it("registers an explicit role update route", () => {
    expect(V3_ROUTES).toContain("/v3/meta/team-member/role/update");
  });

  it("lets an existing team admin promote and demote another active member", async () => {
    const owner = await service.createNormalUser({ username: "owner" });
    const admin = await service.createNormalUser({ username: "admin" });
    const member = await service.createNormalUser({ username: "member" });
    const ownerCtx = context(owner.user_id, owner.default_user_key);
    const team = await service.createTeamForCaller({ name: "test", owner_user_id: owner.user_id }, ownerCtx);
    await service.addTeamMemberForCaller({ team_id: team.team_id, user_id: admin.user_id, role: "admin" }, ownerCtx);
    await service.addTeamMemberForCaller({ team_id: team.team_id, user_id: member.user_id }, ownerCtx);

    const promoted = await service.updateTeamMemberRoleForCaller(
      team.team_id,
      member.user_id,
      "admin",
      context(admin.user_id, admin.default_user_key),
    );
    expect(promoted.role).toBe("admin");

    const demoted = await service.updateTeamMemberRoleForCaller(
      team.team_id,
      member.user_id,
      "member",
      ownerCtx,
    );
    expect(demoted.role).toBe("member");
  });

  it("lets a system admin manage membership without joining the team", async () => {
    const owner = await service.createNormalUser({ username: "owner" });
    const member = await service.createNormalUser({ username: "member" });
    const systemAdmin = await store.createUser({
      username: "system-admin",
      auth_provider: "local",
      external_id: "system-admin",
      user_type: "system_admin",
    });
    const team = await service.createTeamForCaller(
      { name: "test", owner_user_id: owner.user_id },
      context(owner.user_id, owner.default_user_key),
    );
    const systemCtx = context(systemAdmin.user_id, "system-admin-key", true);

    await expect(service.listTeamsForCaller(systemCtx)).resolves.toMatchObject({
      items: [expect.objectContaining({ team_id: team.team_id })],
      total: 1,
    });

    await service.addTeamMemberForCaller({ team_id: team.team_id, user_id: member.user_id }, systemCtx);
    await expect(service.listTeamMembersForCaller(team.team_id, systemCtx)).resolves.toMatchObject({ total: 2 });
    await expect(service.listTeamMemberCandidatesForCaller(team.team_id, undefined, systemCtx)).resolves.toBeDefined();

    const promoted = await service.updateTeamMemberRoleForCaller(
      team.team_id,
      member.user_id,
      "admin",
      systemCtx,
    );
    expect(promoted.role).toBe("admin");
    await expect(service.updateTeamMemberRoleForCaller(
      team.team_id,
      owner.user_id,
      "member",
      systemCtx,
    )).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("rejects role changes by ordinary members and self role changes", async () => {
    const owner = await service.createNormalUser({ username: "owner" });
    const admin = await service.createNormalUser({ username: "admin" });
    const member = await service.createNormalUser({ username: "member" });
    const ownerCtx = context(owner.user_id, owner.default_user_key);
    const team = await service.createTeamForCaller({ name: "test", owner_user_id: owner.user_id }, ownerCtx);
    await service.addTeamMemberForCaller({ team_id: team.team_id, user_id: admin.user_id, role: "admin" }, ownerCtx);
    await service.addTeamMemberForCaller({ team_id: team.team_id, user_id: member.user_id }, ownerCtx);

    await expect(service.updateTeamMemberRoleForCaller(
      team.team_id,
      admin.user_id,
      "member",
      context(member.user_id, member.default_user_key),
    )).rejects.toMatchObject({ code: "permission_denied" });

    await expect(service.updateTeamMemberRoleForCaller(
      team.team_id,
      admin.user_id,
      "member",
      context(admin.user_id, admin.default_user_key),
    )).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("keeps the owner immutable and separates add from role update", async () => {
    const owner = await service.createNormalUser({ username: "owner" });
    const member = await service.createNormalUser({ username: "member" });
    const ownerCtx = context(owner.user_id, owner.default_user_key);
    const team = await service.createTeamForCaller({ name: "test", owner_user_id: owner.user_id }, ownerCtx);
    await service.addTeamMemberForCaller({ team_id: team.team_id, user_id: member.user_id }, ownerCtx);

    await expect(service.addTeamMemberForCaller(
      { team_id: team.team_id, user_id: member.user_id, role: "admin" },
      ownerCtx,
    )).rejects.toMatchObject({ code: "member_already_exists" });

  });

  it("only allows the team owner or system admin to delete the team", async () => {
    const owner = await service.createNormalUser({ username: "owner" });
    const admin = await service.createNormalUser({ username: "admin" });
    const ownerCtx = context(owner.user_id, owner.default_user_key);
    const team = await service.createTeamForCaller({ name: "test", owner_user_id: owner.user_id }, ownerCtx);
    await service.addTeamMemberForCaller({ team_id: team.team_id, user_id: admin.user_id, role: "admin" }, ownerCtx);

    await expect(service.deleteTeamsForCaller(
      [team.team_id],
      context(admin.user_id, admin.default_user_key),
    )).rejects.toMatchObject({ code: "permission_denied" });

    await expect(service.deleteTeamsForCaller([team.team_id], ownerCtx)).resolves.toMatchObject({
      deleted_ids: [team.team_id],
    });
  });

  it("lets a team admin update and archive another member's agent", async () => {
    const owner = await service.createNormalUser({ username: "owner" });
    const admin = await service.createNormalUser({ username: "admin" });
    const member = await service.createNormalUser({ username: "member" });
    const ownerCtx = context(owner.user_id, owner.default_user_key);
    const team = await service.createTeamForCaller({ name: "test", owner_user_id: owner.user_id }, ownerCtx);
    await service.addTeamMemberForCaller({ team_id: team.team_id, user_id: admin.user_id, role: "admin" }, ownerCtx);
    await service.addTeamMemberForCaller({ team_id: team.team_id, user_id: member.user_id }, ownerCtx);
    const agent = await service.createAgentForCaller(
      { team_id: team.team_id, owner_user_id: member.user_id, name: "member-agent" },
      ownerCtx,
    );
    const adminCtx = context(admin.user_id, admin.default_user_key);

    await expect(service.updateAgentForCaller(agent.agent_id, { name: "managed" }, adminCtx))
      .resolves.toMatchObject({ name: "managed" });
    await expect(service.archiveAgentForCaller(agent.agent_id, adminCtx))
      .resolves.toMatchObject({ status: "inactive" });
  });
});

function context(userId: string, token: string, isSystemAdmin = false): V3AuthContext {
  return { token, userId, isAdmin: false, isSystemAdmin };
}
