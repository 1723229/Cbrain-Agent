import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { V3AuthContext } from "../router/auth.js";
import { V3_ROUTES } from "../router/v3-meta-router.js";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { MetadataService } from "./metadata-service.js";

describe("team member candidates", () => {
  let store: SqliteMetadataStore;
  let service: MetadataService;

  beforeEach(() => {
    store = new SqliteMetadataStore(":memory:");
    store.init();
    service = new MetadataService(store, "one");
  });

  afterEach(() => store.close());

  it("registers the public candidate-list route", () => {
    expect(V3_ROUTES).toContain("/v3/meta/team-member/candidate/list");
  });

  it("returns searchable active normal users who are not already team members", async () => {
    const owner = await service.createNormalUser({ username: "owner" });
    const alice = await service.createNormalUser({ username: "alice" });
    const carol = await service.createNormalUser({ username: "Carol_Dev" });
    await store.updateUser(carol.user_id, { display_name: "Carol Developer", email: "carol@example.test" });
    const inactive = await service.createNormalUser({ username: "inactive" });
    await store.updateUser(inactive.user_id, { status: "inactive" });
    await store.createUser({
      username: "system-admin",
      auth_provider: "local",
      external_id: "system-admin",
      user_type: "system_admin",
    });

    const ownerContext = context(owner.user_id, owner.default_user_key);
    const team = await service.createTeamForCaller({ name: "test", owner_user_id: owner.user_id }, ownerContext);
    await service.addTeamMemberForCaller({ team_id: team.team_id, user_id: alice.user_id }, ownerContext);

    const aliceAgents = await store.listAgentsByTeam(team.team_id, null, {
      owner_user_id: alice.user_id,
      status: "active",
    });
    expect(aliceAgents.items).toMatchObject([
      { name: "default-agent-alice", owner_user_id: alice.user_id, team_id: team.team_id },
    ]);

    const all = await service.listTeamMemberCandidatesForCaller(team.team_id, undefined, ownerContext);
    expect(all.items.map((item) => item.username)).toEqual(["Carol_Dev"]);
    expect(all.items[0]).toMatchObject({ display_name: "Carol Developer" });
    expect(all.items[0]).not.toHaveProperty("email");

    const byName = await service.listTeamMemberCandidatesForCaller(team.team_id, "carol", ownerContext);
    expect(byName.items.map((item) => item.user_id)).toEqual([carol.user_id]);

    const byDisplayName = await service.listTeamMemberCandidatesForCaller(team.team_id, "developer", ownerContext);
    expect(byDisplayName.items.map((item) => item.user_id)).toEqual([carol.user_id]);

    const byId = await service.listTeamMemberCandidatesForCaller(
      team.team_id,
      carol.user_id.slice(-6).toUpperCase(),
      ownerContext,
    );
    expect(byId.items.map((item) => item.user_id)).toEqual([carol.user_id]);
  });

  it("rejects candidate discovery for non-admin team members", async () => {
    const owner = await service.createNormalUser({ username: "owner" });
    const member = await service.createNormalUser({ username: "member" });
    const ownerContext = context(owner.user_id, owner.default_user_key);
    const team = await service.createTeamForCaller({ name: "test", owner_user_id: owner.user_id }, ownerContext);
    await service.addTeamMemberForCaller({ team_id: team.team_id, user_id: member.user_id }, ownerContext);

    await expect(service.listTeamMemberCandidatesForCaller(
      team.team_id,
      undefined,
      context(member.user_id, member.default_user_key),
    )).rejects.toMatchObject({ code: "permission_denied" });
  });
});

function context(userId: string, token: string): V3AuthContext {
  return { token, userId, isAdmin: false, isSystemAdmin: false };
}
