import { describe, expect, it, vi } from "vitest";
import { GatewayAuthenticationError, GatewayAuthenticator } from "./auth.js";

describe("GatewayAuthenticator", () => {
  it("derives a stable principal from a page API key and caches only the identity", async () => {
    const directory = { verifyUserKey: vi.fn().mockResolvedValue("usr-1") };
    const auth = new GatewayAuthenticator({ directory, cacheTtlMs: 1_000 });
    const first = await auth.authenticate("Bearer page-key");
    const second = await auth.authenticate("Bearer page-key");
    expect(first).toEqual({ id: "user:usr-1", userId: "usr-1", userKey: "page-key" });
    expect(second.id).toBe(first.id);
    expect(directory.verifyUserKey).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(auth)).not.toContain("page-key");
  });

  it("negative-caches invalid keys and rejects missing credentials", async () => {
    const directory = { verifyUserKey: vi.fn().mockResolvedValue(null) };
    const auth = new GatewayAuthenticator({ directory });
    await expect(auth.authenticate("Bearer invalid")).rejects.toBeInstanceOf(GatewayAuthenticationError);
    await expect(auth.authenticate("Bearer invalid")).rejects.toBeInstanceOf(GatewayAuthenticationError);
    await expect(auth.authenticate(undefined)).rejects.toBeInstanceOf(GatewayAuthenticationError);
    expect(directory.verifyUserKey).toHaveBeenCalledTimes(1);
  });

  it("keeps legacy static principals available during migration", async () => {
    const directory = { verifyUserKey: vi.fn() };
    const auth = new GatewayAuthenticator({ directory, staticPrincipals: [{ id: "legacy", token: "gateway-token", userId: "usr-legacy" }] });
    await expect(auth.authenticate("Bearer gateway-token")).resolves.toMatchObject({ id: "legacy", userId: "usr-legacy" });
    expect(directory.verifyUserKey).not.toHaveBeenCalled();
  });

  it("revalidates after expiry and keeps bindings stable across key rotation", async () => {
    let now = 1_000;
    const directory = { verifyUserKey: vi.fn().mockResolvedValue("usr-1") };
    const auth = new GatewayAuthenticator({ directory, cacheTtlMs: 100, now: () => now });
    const first = await auth.authenticate("Bearer first-key");
    now = 1_101;
    await auth.authenticate("Bearer first-key");
    const rotated = await auth.authenticate("Bearer rotated-key");
    expect(directory.verifyUserKey).toHaveBeenCalledTimes(3);
    expect(rotated.id).toBe(first.id);
  });
});
