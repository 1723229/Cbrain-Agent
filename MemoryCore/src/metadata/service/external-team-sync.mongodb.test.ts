import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoMetadataStore } from "../store/mongodb-adapter.js";
import type { ExternalTeamSyncSnapshot } from "../types.js";
import { MetadataService } from "./metadata-service.js";

describe("external team sync on MongoDB", () => {
  let server: MongoMemoryServer;
  let client: MongoClient;
  let store: MongoMetadataStore;
  let service: MetadataService;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    client = new MongoClient(server.getUri());
    await client.connect();
    store = new MongoMetadataStore(client, "external_sync_test", { useTransactions: false, ownsClient: false });
    await store.init();
    service = new MetadataService(store, "test");
  });

  afterAll(async () => {
    await store.close();
    await client.close();
    await server.stop();
  });

  it("应用完整快照并保留手工成员来源", async () => {
    const admin = await store.createUser({ username: "admin", auth_provider: "local", external_id: "admin", user_type: "system_admin" });
    const dev = await store.createUser({ username: "dev", auth_provider: "ldap:zjyj", external_id: "dev", create_default_key: false });
    const externalOnly = await store.createUser({ username: "only", auth_provider: "ldap:zjyj", external_id: "only", create_default_key: false });
    const snapshot: ExternalTeamSyncSnapshot = {
      provider_id: "zentao:main", identity_provider_id: "ldap:zjyj",
      source_url: "https://zentao.example.test", captured_at: new Date().toISOString(), complete: true,
      projects: [{ external_id: "1", name: "Project", code: "p", status: "doing", members: [
        { external_id: "1:dev", account: "dev", role: "member" },
        { external_id: "1:only", account: "only", role: "member" },
      ] }],
    };
    const preview = await service.previewExternalTeamSync(snapshot);
    await service.applyExternalTeamSync({ snapshot, expected_snapshot_hash: preview.snapshot_hash, owner_user_id: admin.user_id, trigger: "initial" });
    const team = (await store.listTeams({ limit: 10, offset: 0 })).items[0]!;
    await store.init();
    await store.addTeamMember({ team_id: team.team_id, user_id: dev.user_id, role: "admin" });

    const closed = { ...snapshot, projects: [{ ...snapshot.projects[0]!, status: "closed", members: [] }] };
    const closePreview = await service.previewExternalTeamSync(closed);
    await service.applyExternalTeamSync({ snapshot: closed, expected_snapshot_hash: closePreview.snapshot_hash, owner_user_id: admin.user_id, trigger: "scheduled" });
    expect((await store.getTeamById(team.team_id))?.status).toBe("archived");
    expect((await store.getTeamMember(team.team_id, dev.user_id))?.role).toBe("admin");
    expect(await store.getTeamMember(team.team_id, externalOnly.user_id)).toBeNull();
    expect((await store.listTeamMemberSources({ team_id: team.team_id, user_id: dev.user_id })).map((row) => row.source_type)).toEqual(["manual"]);
  });
});
