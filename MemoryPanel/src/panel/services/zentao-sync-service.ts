import { readFileSync } from "node:fs";
import type { PanelConfig } from "../config/panel-config.js";
import type { InstanceRegistry } from "../config/instance-registry.js";
import type { Logger } from "../infra/logger.js";
import type { KernelHttpPort } from "../kernel/ports/kernel-http-port.js";
import type { MetaCallContext } from "../kernel/types.js";
import { enqueuePublicSkillsForAgent, ensureDefaultAgentForUser } from "./default-agent-orchestrator.js";
import { getAgentTemplate } from "../state/agent-template-store.js";
import { ZentaoClient, type ZentaoSyncSnapshot } from "../integrations/zentao/zentao-client.js";
import type { PanelDeps } from "../panel-deps.js";

interface SyncPreview {
  provider_id: string;
  snapshot_hash: string;
  counts: Record<string, number>;
  issues: Array<{ code: string; project_ref: string; account: string }>;
}

interface SyncApplyResult {
  state: Record<string, unknown>;
  provisioning_candidates: Array<{ team_id: string; user_id: string }>;
}

export class ZentaoSyncServiceError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "ZentaoSyncServiceError";
  }
}

export class ZentaoSyncService {
  private readonly client: ZentaoClient;
  private readonly provisioningInFlight = new Set<string>();

  constructor(
    private readonly config: PanelConfig,
    private readonly registry: InstanceRegistry,
    private readonly kernelHttp: KernelHttpPort,
    private readonly logger: Logger,
  ) {
    this.client = new ZentaoClient({
      baseUrl: config.zentao.baseUrl,
      account: config.zentao.account,
      passwordProvider: () => {
        if (!config.zentao.passwordFile) throw new Error("CBRAIN_ZENTAO_PASSWORD_FILE is required");
        return readFileSync(config.zentao.passwordFile, "utf8").trim();
      },
      identityProviderId: config.zentao.identityProviderId,
      providerId: config.zentao.providerId,
      timeoutMs: config.zentao.requestTimeoutMs,
      memberConcurrency: config.zentao.memberConcurrency,
    });
  }

  get enabled(): boolean {
    return this.config.zentao.enabled;
  }

  async status(instanceId: string): Promise<Record<string, unknown>> {
    const state = await this.internal<Record<string, unknown> | null>(instanceId, "/v3/internal/meta/external-team-sync/state", {
      provider_id: this.config.zentao.providerId,
    }, true);
    return {
      enabled: this.enabled,
      provider_id: this.config.zentao.providerId,
      source_url: this.config.zentao.baseUrl,
      interval_ms: this.config.zentao.syncIntervalMs,
      state,
    };
  }

  async preview(instanceId: string, trigger: "initial" | "manual" | "scheduled" = "manual"): Promise<{ preview: SyncPreview; snapshot: ZentaoSyncSnapshot }> {
    this.assertEnabled();
    const snapshot = await this.fetchSnapshot(instanceId, trigger);
    const preview = await this.internal<SyncPreview>(instanceId, "/v3/internal/meta/external-team-sync/preview", { snapshot });
    return { preview, snapshot };
  }

  async apply(input: {
    instanceId: string;
    ownerUserId: string;
    expectedSnapshotHash: string;
    trigger: "initial" | "manual" | "scheduled";
    ctx?: MetaCallContext;
    deps?: PanelDeps;
  }): Promise<SyncApplyResult & { provisioning: { success: number; failed: number; pending: number } }> {
    this.assertEnabled();
    const snapshot = await this.fetchSnapshot(input.instanceId, input.trigger);
    const result = await this.internal<SyncApplyResult>(input.instanceId, "/v3/internal/meta/external-team-sync/apply", {
      snapshot,
      expected_snapshot_hash: input.expectedSnapshotHash,
      owner_user_id: input.ownerUserId,
      trigger: input.trigger,
      next_run_at: new Date(Date.now() + this.config.zentao.syncIntervalMs).toISOString(),
    });
    if (input.ctx && input.deps) {
      void this.provisionCandidates(
        result.provisioning_candidates,
        input.instanceId,
        input.ctx,
        input.deps,
      ).catch((error) => {
        this.logger.warn("[zentao-sync] background provisioning interrupted", {
          instanceId: input.instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return {
        ...result,
        provisioning: { success: 0, failed: 0, pending: result.provisioning_candidates.length },
      };
    }
    const provisioning = await this.provisionCandidates(
      result.provisioning_candidates,
      input.instanceId,
      input.ctx,
      input.deps,
    );
    return { ...result, provisioning };
  }

  async scheduledSync(instanceId: string, deps: PanelDeps): Promise<void> {
    if (!this.enabled) return;
    const status = await this.status(instanceId);
    const state = status.state as { initialized?: boolean } | null;
    if (!state?.initialized) return;
    const ownerUserId = await this.resolveSystemAdmin(instanceId);
    const { preview } = await this.preview(instanceId, "scheduled");
    await this.apply({
      instanceId,
      ownerUserId,
      expectedSnapshotHash: preview.snapshot_hash,
      trigger: "scheduled",
      deps,
    });
  }

  private async provisionCandidates(
    candidates: Array<{ team_id: string; user_id: string }>,
    instanceId: string,
    ctx?: MetaCallContext,
    deps?: PanelDeps,
  ): Promise<{ success: number; failed: number; pending: number }> {
    if (!deps) return { success: 0, failed: 0, pending: candidates.length };
    let success = 0;
    let failed = 0;
    let pending = 0;
    for (const candidate of candidates) {
      const candidateKey = `${instanceId}:${candidate.team_id}:${candidate.user_id}`;
      if (this.provisioningInFlight.has(candidateKey)) {
        pending += 1;
        continue;
      }
      this.provisioningInFlight.add(candidateKey);
      try {
        if (ctx) {
          await ensureDefaultAgentForUser({ teamId: candidate.team_id, userId: candidate.user_id }, ctx, deps);
        } else {
          const internalCtx = this.contextForInstance(deps, instanceId);
          const template = getAgentTemplate(
            deps.config.agentTemplateDir,
            internalCtx.instanceId,
            candidate.team_id,
          );
          const users = await this.internal<{ items: Array<{ user_id: string; username: string }> }>(
            internalCtx.instanceId,
            "/v3/internal/meta/user/list-by-instance",
            { user_ids: [candidate.user_id], status: "active", limit: 1, offset: 0 },
          );
          const username = users.items[0]?.username ?? candidate.user_id;
          const agent = await this.internal<{ agent_id: string; team_id: string; owner_user_id: string }>(
            internalCtx.instanceId,
            "/v3/internal/meta/external-team-sync/default-agent/ensure",
            {
              team_id: candidate.team_id,
              user_id: candidate.user_id,
              name: template?.name || `default-agent-${username}`,
              description: template?.description ?? "默认助手，可处理通用开发任务与日常协作。",
              prompt: template?.prompt ?? "",
              visibility: template?.visibility ?? "team",
              metadata_json: template?.metadata_json ?? JSON.stringify({ ui: { role_prompt: "", rules_prompt: "" } }),
            },
          );
          await enqueuePublicSkillsForAgent(agent, internalCtx, deps);
          const hasPrivateTemplateAssets = Object.values(template?.asset_ids ?? {}).some((ids) => (ids?.length ?? 0) > 0);
          if (hasPrivateTemplateAssets) {
            pending += 1;
            continue;
          }
        }
        await this.markProvisioning((ctx ?? this.contextForInstance(deps, instanceId)).instanceId, candidate, "success");
        success += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const targetInstanceId = ctx?.instanceId ?? instanceId;
        if (targetInstanceId) await this.markProvisioning(targetInstanceId, candidate, "failed", message.slice(0, 4_096));
        this.logger.warn("[zentao-sync] member provisioning failed", {
          instanceId: targetInstanceId,
          teamId: candidate.team_id,
          userId: candidate.user_id,
          error: message,
        });
        failed += 1;
      } finally {
        this.provisioningInFlight.delete(candidateKey);
      }
    }
    return { success, failed, pending };
  }

  private contextForInstance(deps: PanelDeps, instanceId: string): MetaCallContext {
    const entry = deps.instanceRegistry.resolve(instanceId);
    return {
      instanceId: entry.instance_id,
      gatewayEndpoint: entry.gateway_endpoint,
      gatewayApiKey: entry.api_key,
    };
  }

  private markProvisioning(
    instanceId: string,
    candidate: { team_id: string; user_id: string },
    status: "success" | "failed",
    error?: string,
  ): Promise<{ ok: true }> {
    return this.internal(instanceId, "/v3/internal/meta/external-team-sync/provisioning", {
      ...candidate,
      source_type: "zentao",
      status,
      error: error ?? null,
    });
  }

  private async resolveSystemAdmin(instanceId: string): Promise<string> {
    const page = await this.internal<{ items: Array<{ user_id: string }>; total: number }>(
      instanceId,
      "/v3/internal/meta/user/list-by-instance",
      { status: "active", user_type: "system_admin", limit: 1, offset: 0 },
    );
    const userId = page.items[0]?.user_id;
    if (!userId) throw new Error("active system admin not found");
    return userId;
  }

  private async fetchSnapshot(
    instanceId: string,
    trigger: "initial" | "manual" | "scheduled",
  ): Promise<ZentaoSyncSnapshot> {
    try {
      return await this.client.fetchSnapshot();
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
      await this.internal(instanceId, "/v3/internal/meta/external-team-sync/failure", {
        provider_id: this.config.zentao.providerId,
        trigger,
        error: message,
        next_run_at: new Date(Date.now() + this.config.zentao.syncIntervalMs).toISOString(),
      }).catch(() => undefined);
      throw error;
    }
  }

  private async internal<T>(instanceId: string, path: string, body: unknown, allowNull = false): Promise<T> {
    const entry = this.registry.resolve(instanceId);
    const env = await this.kernelHttp.postEnvelope<T>(path, body, {
      endpoint: entry.gateway_endpoint,
      apiKey: entry.api_key,
      instanceId: entry.instance_id,
      timeoutMs: Math.max(this.config.metadataRemoteTimeoutMs, this.config.zentao.requestTimeoutMs),
    });
    if (env.code !== 0 || ((!allowNull) && (env.data === null || env.data === undefined))) {
      throw new ZentaoSyncServiceError(
        env.code >= 400 && env.code <= 599 ? env.code : 502,
        env.message || "EXTERNAL_SYNC_REJECTED",
      );
    }
    return env.data as T;
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new Error("ZenTao sync is disabled");
  }
}
