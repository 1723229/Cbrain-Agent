import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MetadataService } from "./metadata-service.js";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { hashWebSessionToken } from "../utils/auth-session.js";

describe("federated identity and web sessions", () => {
  let store: SqliteMetadataStore;
  let service: MetadataService;

  beforeEach(() => {
    store = new SqliteMetadataStore(":memory:");
    store.init();
    service = new MetadataService(store, "one");
  });

  afterEach(() => store.close());

  it("creates one LDAP user without an agent API key and resolves its session", async () => {
    const login = await service.loginFederatedUser({
      provider_id: "ldap:giga",
      subject_id: "entry-uuid-1",
      username: "alice",
      display_name: "Alice",
      email: "alice@example.test",
      raw_profile_json: JSON.stringify({ uid: "alice" }),
    });

    expect(login.user.username).toBe("alice");
    expect(login.session_token).toMatch(/^cs-/);
    expect((await store.listUserKeys(login.user.user_id)).items).toEqual([]);
    expect((await service.resolveWebSession(login.session_token))?.user_id).toBe(login.user.user_id);

    const again = await service.loginFederatedUser({
      provider_id: "ldap:giga",
      subject_id: "entry-uuid-1",
      username: "alice-renamed",
      display_name: "Alice Renamed",
      email: "alice@example.test",
      raw_profile_json: "{}",
    });
    expect(again.user.user_id).toBe(login.user.user_id);
    expect((await store.listUsers()).total).toBe(1);
  });

  it("rejects expired, revoked and inactive-user sessions", async () => {
    const login = await service.loginFederatedUser({
      provider_id: "ldap:giga",
      subject_id: "entry-uuid-2",
      username: "bob",
      raw_profile_json: "{}",
    }, { ttlSeconds: -1 });
    expect(await service.resolveWebSession(login.session_token)).toBeNull();

    const active = await service.loginFederatedUser({
      provider_id: "ldap:giga",
      subject_id: "entry-uuid-2",
      username: "bob",
      raw_profile_json: "{}",
    });
    expect(await store.getAuthSessionByTokenHash(hashWebSessionToken(login.session_token))).toBeNull();
    await service.revokeWebSession(active.session_token);
    expect(await service.resolveWebSession(active.session_token)).toBeNull();

    const replacement = await service.loginFederatedUser({
      provider_id: "ldap:giga",
      subject_id: "entry-uuid-2",
      username: "bob",
      raw_profile_json: "{}",
    });
    await store.updateUser(replacement.user.user_id, { status: "inactive" });
    expect(await service.resolveWebSession(replacement.session_token)).toBeNull();
  });

  it("invalidates an agent API key when its owner is inactive", async () => {
    const created = await service.createNormalUser({ username: "carol" });
    expect(await service.verifyAuth(created.default_user_key)).not.toBeNull();
    await store.updateUser(created.user_id, { status: "inactive" });
    expect(await service.verifyAuth(created.default_user_key)).toBeNull();
  });

  it("issues emergency sessions only for active system administrator API keys", async () => {
    const normal = await service.createNormalUser({ username: "normal" });
    await expect(service.loginSystemAdminWithApiKey(normal.default_user_key)).rejects.toMatchObject({
      code: "permission_denied",
    });

    const admin = await store.createUser({
      username: "admin",
      auth_provider: "local",
      external_id: "admin",
      user_type: "system_admin",
    });
    const adminKey = await store.getDefaultUserKey(admin.user_id);
    const login = await service.loginSystemAdminWithApiKey(adminKey!.key_value);
    expect(login.user).toMatchObject({ user_id: admin.user_id, user_type: "system_admin" });
    expect(login.session_token).toMatch(/^cs-/);

    await store.updateUser(admin.user_id, { status: "inactive" });
    await expect(service.loginSystemAdminWithApiKey(adminKey!.key_value)).rejects.toMatchObject({
      code: "invalid_credentials",
    });
  });

  it("provisions new LDAP identities and deactivates mapped users missing from a complete snapshot", async () => {
    const present = await service.loginFederatedUser({
      provider_id: "ldap:giga",
      subject_id: "present",
      username: "present",
      raw_profile_json: "{}",
    });
    const missing = await service.loginFederatedUser({
      provider_id: "ldap:giga",
      subject_id: "missing",
      username: "missing",
      raw_profile_json: "{}",
    });

    const result = await service.syncFederatedUsers("ldap:giga", [
      {
        subject_id: "present",
        username: "present-renamed",
        raw_profile_json: "{}",
      },
      {
        subject_id: "new-directory-user",
        username: "new-directory-user",
        display_name: "New Directory User",
        raw_profile_json: "{}",
      },
    ]);

    expect(result).toEqual({ created: 1, updated: 1, deactivated: 1 });
    expect((await store.getUserById(present.user.user_id))?.status).toBe("active");
    expect((await store.getUserById(missing.user.user_id))?.status).toBe("inactive");
    expect(await service.resolveWebSession(missing.session_token)).toBeNull();
    const createdIdentity = await store.getExternalIdentity("ldap:giga", "new-directory-user");
    expect(createdIdentity).not.toBeNull();
    expect((await store.getUserById(createdIdentity!.user_id))?.display_name).toBe("New Directory User");
    expect((await store.listUserKeys(createdIdentity!.user_id)).items).toEqual([]);
  });

  it("reveals keys only to their owner and allows revoking the final key", async () => {
    const owner = await service.createNormalUser({ username: "owner" });
    const adminUser = await store.createUser({
      username: "admin",
      auth_provider: "local",
      external_id: "admin",
      user_type: "system_admin",
    });
    const adminKey = await store.getDefaultUserKey(adminUser.user_id);

    const own = await service.listUserKeysForCaller(owner.user_id, {
      token: owner.default_user_key,
      userId: owner.user_id,
      isAdmin: false,
      isSystemAdmin: false,
    });
    expect('key_value' in own.items[0]! ? own.items[0].key_value : undefined).toBe(owner.default_user_key);

    const adminView = await service.listUserKeysForCaller(owner.user_id, {
      token: adminKey!.key_value,
      userId: adminUser.user_id,
      isAdmin: false,
      isSystemAdmin: true,
    });
    expect('key_value' in adminView.items[0]! ? adminView.items[0].key_value : undefined).toBeUndefined();

    await service.revokeUserKey(own.items[0]!.key_id);
    expect((await store.listUserKeys(owner.user_id)).items).toEqual([]);
  });
});
