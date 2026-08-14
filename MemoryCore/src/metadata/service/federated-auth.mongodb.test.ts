import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";

import { MetadataService } from "./metadata-service.js";
import { MongoMetadataStore } from "../store/mongodb-adapter.js";
import type { V3AuthContext } from "../router/auth.js";

describe("federated auth on MongoDB", () => {
  let server: MongoMemoryServer;
  let client: MongoClient;
  let store: MongoMetadataStore;
  let service: MetadataService;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    client = new MongoClient(server.getUri());
    await client.connect();
    store = new MongoMetadataStore(client, "metadata_test", { useTransactions: false, ownsClient: false });
    await store.init();
    service = new MetadataService(store, "one");
  });

  afterAll(async () => {
    await store.close();
    await client.close();
    await server.stop();
  });

  it("persists external identities and hashed sessions", async () => {
    const login = await service.loginFederatedUser({
      provider_id: "ldap:giga",
      subject_id: "mongo-entry-uuid",
      username: "mongo-user",
      raw_profile_json: "{}",
    });
    expect((await store.getExternalIdentity("ldap:giga", "mongo-entry-uuid"))?.user_id).toBe(login.user.user_id);
    expect((await store.listUserKeys(login.user.user_id)).items).toEqual([]);
    expect((await service.resolveWebSession(login.session_token))?.user_id).toBe(login.user.user_id);
    expect((await store.getAuthSessionByTokenHash(login.session_token))).toBeNull();
  });

  it("searches team member candidates and excludes active members", async () => {
    const owner = await service.createNormalUser({ username: "mongo-owner" });
    const candidate = await service.createNormalUser({ username: "Mongo_Candidate" });
    const inactive = await service.createNormalUser({ username: "mongo-inactive-candidate" });
    await store.updateUser(inactive.user_id, { status: "inactive" });
    const ctx: V3AuthContext = {
      token: owner.default_user_key,
      userId: owner.user_id,
      isAdmin: false,
      isSystemAdmin: false,
    };
    const team = await service.createTeamForCaller({
      name: "mongo-team",
      owner_user_id: owner.user_id,
    }, ctx);

    const found = await service.listTeamMemberCandidatesForCaller(team.team_id, "candidate", ctx);
    expect(found.items.map((item) => item.user_id)).toEqual([candidate.user_id]);

    await service.addTeamMemberForCaller({ team_id: team.team_id, user_id: candidate.user_id }, ctx);
    expect((await service.listTeamMemberCandidatesForCaller(team.team_id, "candidate", ctx)).items).toEqual([]);
  });
});
