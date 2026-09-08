import { getPanelSession } from "../panelSession";
import { ApiError, request } from "./base";
import type { MetaEnvelope } from "./types";

export interface ZentaoSyncCounts {
  teams_create: number;
  teams_update: number;
  teams_inactivate: number;
  teams_reactivate: number;
  members_add: number;
  members_remove: number;
  members_role_change: number;
  unresolved_users: number;
}

export interface ZentaoSyncPreview {
  provider_id: string;
  snapshot_hash: string;
  counts: ZentaoSyncCounts;
  issues: Array<{ code: string; project_ref: string; account: string }>;
}

export interface ZentaoSyncStatus {
  enabled: boolean;
  provider_id: string;
  source_url: string;
  interval_ms: number;
  state: null | {
    initialized: boolean;
    status: string;
    last_attempt_at?: string | null;
    last_success_at?: string | null;
    next_run_at?: string | null;
    counts_json?: string;
    error?: string | null;
  };
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const instanceId = getPanelSession()?.instanceId;
  if (!instanceId) throw new ApiError(401, "Unauthorized", "no active panel session");
  const envelope = await request<MetaEnvelope<T>>(method, `/api/v1/integrations/zentao/${path}`, body, {
    "X-Tdai-Service-Id": instanceId,
  });
  if (envelope.code !== 0 || envelope.data == null) {
    throw new ApiError(200, envelope.message, "", { code: envelope.code, rawMessage: envelope.message, requestId: envelope.request_id });
  }
  return envelope.data;
}

export const zentaoSyncApi = {
  status: () => call<ZentaoSyncStatus>("GET", "status"),
  preview: () => call<ZentaoSyncPreview>("POST", "preview", {}),
  apply: (snapshotHash: string, initial: boolean) => call<{ provisioning: { success: number; failed: number; pending: number } }>(
    "POST",
    "apply",
    { snapshot_hash: snapshotHash, initial },
  ),
};
