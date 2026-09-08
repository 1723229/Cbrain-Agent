import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerZentaoSyncRoutes } from "../src/panel/http/routes/zentao-sync.js";
import type { PanelDeps } from "../src/panel/panel-deps.js";

function appFor(userType: "normal" | "system_admin") {
  const api = new Hono();
  const status = vi.fn().mockResolvedValue({ enabled: true, state: null });
  const preview = vi.fn().mockResolvedValue({ preview: { snapshot_hash: "a".repeat(64), counts: {}, issues: [] } });
  const apply = vi.fn().mockResolvedValue({ state: { initialized: true }, provisioning: { success: 1, failed: 0, pending: 0 } });
  const deps = {
    config: { session: { cookieName: "cbrain_session" } },
    instanceRegistry: { resolve: () => ({ instance_id: "default", gateway_endpoint: "http://core", api_key: "internal" }) },
    authService: { resolveSession: vi.fn().mockResolvedValue({ user_id: "usr-1", username: "u", user_type: userType }) },
    zentaoSyncService: { status, preview, apply },
  } as unknown as PanelDeps;
  registerZentaoSyncRoutes(api, deps);
  return { api, status, preview, apply };
}

describe("ZenTao sync routes", () => {
  it("仅系统管理员可以访问", async () => {
    const { api, status } = appFor("normal");
    const res = await api.request("/integrations/zentao/status", {
      headers: { "X-Tdai-Service-Id": "default", Cookie: "cbrain_session=cs-valid-session-token" },
    });
    expect(res.status).toBe(403);
    expect(status).not.toHaveBeenCalled();
  });

  it("系统管理员可以读取状态", async () => {
    const { api, status } = appFor("system_admin");
    const res = await api.request("/integrations/zentao/status", {
      headers: { "X-Tdai-Service-Id": "default", Cookie: "cbrain_session=cs-valid-session-token" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({ code: 0, data: { enabled: true } });
    expect(status).toHaveBeenCalledWith("default");
  });

  it("系统管理员可以预览并用哈希确认应用", async () => {
    const { api, preview, apply } = appFor("system_admin");
    const headers = {
      "X-Tdai-Service-Id": "default",
      Cookie: "cbrain_session=cs-valid-session-token",
      "content-type": "application/json",
    };
    expect((await api.request("/integrations/zentao/preview", { method: "POST", headers })).status).toBe(200);
    const res = await api.request("/integrations/zentao/apply", {
      method: "POST",
      headers,
      body: JSON.stringify({ snapshot_hash: "a".repeat(64), initial: true }),
    });
    expect(res.status).toBe(200);
    expect(preview).toHaveBeenCalledWith("default");
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: "default",
      ownerUserId: "usr-1",
      expectedSnapshotHash: "a".repeat(64),
      trigger: "initial",
    }));
  });
});
