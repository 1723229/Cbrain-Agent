import type { Context, Hono } from "hono";
import type { PanelDeps } from "../../panel-deps.js";
import { validatePanelMetaHeaders } from "../middleware/validate-panel-headers.js";
import { respondControlError } from "../envelope.js";
import type { MetaCallContext } from "../../kernel/types.js";
import { ZentaoSyncServiceError } from "../../services/zentao-sync-service.js";

function contextOf(c: Context): MetaCallContext {
  const meta = c.get("panelMeta");
  return {
    instanceId: meta.instanceId,
    gatewayEndpoint: meta.gatewayEndpoint,
    gatewayApiKey: meta.gatewayApiKey,
    userKey: meta.userKey,
    userId: meta.user.user_id,
    reqId: c.get("reqId"),
  };
}

function requireSystemAdmin(c: Context): Response | null {
  return c.get("panelMeta").user.user_type === "system_admin"
    ? null
    : respondControlError(c, 403, "SYSTEM_ADMIN_REQUIRED");
}

async function run<T>(c: Context, fn: () => Promise<T>): Promise<Response> {
  try {
    const data = await fn();
    return c.json({ code: 0, message: "ok", request_id: c.get("reqId") ?? "", data });
  } catch (error) {
    if (error instanceof ZentaoSyncServiceError) {
      return respondControlError(c, error.status, error.code);
    }
    return respondControlError(c, 502, "ZENTAO_UNAVAILABLE");
  }
}

export function registerZentaoSyncRoutes(api: Hono, deps: PanelDeps): void {
  const auth = validatePanelMetaHeaders(deps);

  api.get("/integrations/zentao/status", auth, async (c) => {
    const denied = requireSystemAdmin(c);
    if (denied) return denied;
    const meta = c.get("panelMeta");
    return run(c, () => deps.zentaoSyncService.status(meta.instanceId));
  });

  api.post("/integrations/zentao/preview", auth, async (c) => {
    const denied = requireSystemAdmin(c);
    if (denied) return denied;
    const meta = c.get("panelMeta");
    return run(c, async () => (await deps.zentaoSyncService.preview(meta.instanceId)).preview);
  });

  api.post("/integrations/zentao/apply", auth, async (c) => {
    const denied = requireSystemAdmin(c);
    if (denied) return denied;
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const expected = typeof body.snapshot_hash === "string" ? body.snapshot_hash : "";
    if (!/^[a-f0-9]{64}$/.test(expected)) return respondControlError(c, 400, "INVALID_SNAPSHOT_HASH");
    const meta = c.get("panelMeta");
    return run(c, () => deps.zentaoSyncService.apply({
      instanceId: meta.instanceId,
      ownerUserId: meta.user.user_id,
      expectedSnapshotHash: expected,
      trigger: body.initial === true ? "initial" : "manual",
      ctx: contextOf(c),
      deps,
    }));
  });
}
