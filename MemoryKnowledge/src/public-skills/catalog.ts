import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import { parse as parseYaml } from "yaml";

import type { PublicSkillCatalogConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { GitSourceFetcher } from "../source-fetcher/git-fetcher.js";

const log = createLogger("public-skill-catalog");
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 100;
const CORE_PARTITION = "core";

export type PublicSkillLayer = "core" | "extension";

export interface PublicSkillManifestEntry {
  path: string;
  size_bytes: number;
  mime_type: string;
  is_executable: boolean;
}

export interface PublicSkillItem {
  item_id: string;
  source_id: string;
  repo_path: string;
  name: string;
  description: string;
  layer: PublicSkillLayer;
  pack_key: string | null;
  category_path: string;
  partition_key: string;
  source_revision: string;
  content_hash: string;
  manifest: PublicSkillManifestEntry[];
  total_bytes: number;
  updated_at: string;
}

export interface PublicSkillSnapshot extends PublicSkillItem {
  content: string;
  resources: Array<{
    path: string;
    content: string;
    encoding: "base64";
    mime_type: string;
    is_executable: boolean;
  }>;
}

export interface PublicSkillDocument {
  document_key: string;
  repo_path: string;
  title: string;
  content: string;
  source_revision: string;
  updated_at: string;
}

export interface PublicSkillTeamPolicy {
  team_id: string;
  pack_keys: string[];
  item_ids: string[];
  updated_by: string | null;
  updated_at: string | null;
}

interface ParsedItem extends PublicSkillItem {
  absoluteDir: string;
}

interface ParsedPartition {
  partition_key: string;
  layer: PublicSkillLayer;
  pack_key: string | null;
  repo_path: string;
  items: ParsedItem[];
  document: PublicSkillDocument | null;
}

interface PartitionResult {
  partition_key: string;
  layer: PublicSkillLayer;
  pack_key: string | null;
  repo_path: string;
  partition?: ParsedPartition;
  error?: string;
}

export interface ParsedPublicSkillRepository {
  partitions: PartitionResult[];
  documents: PublicSkillDocument[];
}

export class PublicSkillCatalog {
  private readonly fetcher = new GitSourceFetcher();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: Database.Database,
    private readonly dataDir: string,
    readonly config: PublicSkillCatalogConfig,
  ) {}

  start(): void {
    if (!this.config.enabled || this.timer) return;
    this.recoverInterruptedBootstrap();
    void this.sync(this.config.defaultServiceId);
    this.timer = setInterval(() => void this.sync(this.config.defaultServiceId), this.config.syncIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private recoverInterruptedBootstrap(): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE public_skill_bootstrap_item SET status='pending',next_attempt_at=0,
      last_error=COALESCE(last_error,'recovered after restart'),updated_at=? WHERE status='installing'`).run(now);
    this.db.prepare(`UPDATE public_skill_bootstrap_job SET status='pending',updated_at=? WHERE status='running'`).run(now);
  }

  async ensureFresh(serviceId: string, maxAgeMs = this.config.syncIntervalMs): Promise<void> {
    const status = this.getStatus(serviceId);
    const last = status.last_sync_at ? Date.parse(status.last_sync_at) : 0;
    if (!last || Date.now() - last > maxAgeMs) await this.sync(serviceId);
  }

  async sync(serviceId: string): Promise<ReturnType<PublicSkillCatalog["getStatus"]>> {
    if (!this.config.enabled) return this.getStatus(serviceId);
    const existing = this.inFlight.get(serviceId);
    if (existing) {
      await existing;
      return this.getStatus(serviceId);
    }
    const task = this.performSync(serviceId).finally(() => this.inFlight.delete(serviceId));
    this.inFlight.set(serviceId, task);
    await task;
    return this.getStatus(serviceId);
  }

  getStatus(serviceId: string) {
    const row = this.db.prepare(`SELECT * FROM public_skill_catalog_source WHERE service_id=? AND source_id=?`)
      .get(serviceId, this.config.sourceId) as Record<string, unknown> | undefined;
    const partitions = this.db.prepare(`SELECT partition_key,layer,pack_key,repo_path,active_commit,status,last_error,
      last_sync_at,last_success_at,updated_at FROM public_skill_catalog_partition
      WHERE service_id=? AND source_id=? ORDER BY CASE WHEN partition_key='core' THEN 0 ELSE 1 END,partition_key`)
      .all(serviceId, this.config.sourceId);
    return {
      enabled: this.config.enabled,
      source_id: this.config.sourceId,
      source_name: this.config.sourceName,
      repo_url: this.config.repoUrl,
      branch: this.config.branch,
      status: String(row?.status ?? (this.config.enabled ? "empty" : "disabled")),
      active_commit: typeof row?.active_commit === "string" ? row.active_commit : null,
      last_error: typeof row?.last_error === "string" ? row.last_error : null,
      last_sync_at: typeof row?.last_sync_at === "string" ? row.last_sync_at : null,
      last_success_at: typeof row?.last_success_at === "string" ? row.last_success_at : null,
      auto_install_on_agent_create: this.config.autoInstallOnAgentCreate,
      partitions,
    };
  }

  list(
    serviceId: string,
    query = "",
    limit = 100,
    offset = 0,
    filters: { layer?: string; packKey?: string } = {},
  ): { items: PublicSkillItem[]; total: number } {
    const where = ["service_id=?", "source_id=?", "(name LIKE ? OR description LIKE ?)"];
    const needle = `%${query.trim()}%`;
    const args: unknown[] = [serviceId, this.config.sourceId, needle, needle];
    if (filters.layer) { where.push("layer=?"); args.push(filters.layer); }
    if (filters.packKey) { where.push("pack_key=?"); args.push(filters.packKey); }
    const clause = where.join(" AND ");
    const total = Number((this.db.prepare(`SELECT COUNT(*) count FROM public_skill_catalog_item WHERE ${clause}`)
      .get(...args) as { count: number }).count);
    const rows = this.db.prepare(`SELECT * FROM public_skill_catalog_item WHERE ${clause}
      ORDER BY CASE WHEN layer='core' THEN 0 ELSE 1 END,pack_key,name LIMIT ? OFFSET ?`)
      .all(...args, Math.min(Math.max(limit, 1), 1000), Math.max(offset, 0));
    return { items: rows.map((row) => this.toItem(row as CatalogItemRow)), total };
  }

  effectiveItems(serviceId: string, teamId: string): { items: PublicSkillItem[]; total: number } {
    const policy = this.getTeamPolicy(serviceId, teamId);
    const items = this.allItems(serviceId).filter((item) =>
      item.layer === "core" ||
      (item.pack_key !== null && policy.pack_keys.includes(item.pack_key)) ||
      policy.item_ids.includes(item.item_id));
    return { items, total: items.length };
  }

  get(serviceId: string, itemId: string): PublicSkillItem | null {
    const row = this.db.prepare(`SELECT * FROM public_skill_catalog_item
      WHERE service_id=? AND source_id=? AND item_id=?`)
      .get(serviceId, this.config.sourceId, itemId) as CatalogItemRow | undefined;
    return row ? this.toItem(row) : null;
  }

  documents(serviceId: string): PublicSkillDocument[] {
    return this.db.prepare(`SELECT document_key,repo_path,title,content,source_revision,updated_at
      FROM public_skill_catalog_document WHERE service_id=? AND source_id=?
      ORDER BY CASE document_key WHEN 'root' THEN 0 WHEN 'core' THEN 1 WHEN 'extensions' THEN 2 ELSE 3 END,document_key`)
      .all(serviceId, this.config.sourceId) as PublicSkillDocument[];
  }

  getTeamPolicy(serviceId: string, teamId: string): PublicSkillTeamPolicy {
    const header = this.db.prepare(`SELECT updated_by,updated_at FROM public_skill_team_policy
      WHERE service_id=? AND source_id=? AND team_id=?`).get(serviceId, this.config.sourceId, teamId) as
      { updated_by: string; updated_at: string } | undefined;
    const rows = this.db.prepare(`SELECT selection_type,selection_key FROM public_skill_team_policy_selection
      WHERE service_id=? AND source_id=? AND team_id=? ORDER BY selection_type,selection_key`)
      .all(serviceId, this.config.sourceId, teamId) as Array<{ selection_type: string; selection_key: string }>;
    const availablePacks = new Set((this.db.prepare(`SELECT DISTINCT pack_key FROM public_skill_catalog_item
      WHERE service_id=? AND source_id=? AND layer='extension' AND pack_key IS NOT NULL`)
      .all(serviceId, this.config.sourceId) as Array<{ pack_key: string }>).map((row) => row.pack_key));
    const availableItems = new Set((this.db.prepare(`SELECT item_id FROM public_skill_catalog_item
      WHERE service_id=? AND source_id=? AND layer='extension'`)
      .all(serviceId, this.config.sourceId) as Array<{ item_id: string }>).map((row) => row.item_id));
    return {
      team_id: teamId,
      pack_keys: rows.filter((row) => row.selection_type === "pack" && availablePacks.has(row.selection_key)).map((row) => row.selection_key),
      item_ids: rows.filter((row) => row.selection_type === "item" && availableItems.has(row.selection_key)).map((row) => row.selection_key),
      updated_by: header?.updated_by ?? null,
      updated_at: header?.updated_at ?? null,
    };
  }

  setTeamPolicy(params: { serviceId: string; teamId: string; packKeys: string[]; itemIds: string[]; updatedBy: string }): PublicSkillTeamPolicy {
    const packKeys = unique(params.packKeys);
    let itemIds = unique(params.itemIds);
    if (packKeys.length > 1000 || itemIds.length > 1000) throw new CatalogError("PUBLIC_SKILL_POLICY_TOO_LARGE");
    const availablePacks = new Set((this.db.prepare(`SELECT DISTINCT pack_key FROM public_skill_catalog_item
      WHERE service_id=? AND source_id=? AND layer='extension' AND pack_key IS NOT NULL`)
      .all(params.serviceId, this.config.sourceId) as Array<{ pack_key: string }>).map((row) => row.pack_key));
    if (packKeys.some((key) => !availablePacks.has(key))) throw new CatalogError("PUBLIC_SKILL_PACK_NOT_FOUND");
    if (itemIds.length) {
      const placeholders = itemIds.map(() => "?").join(",");
      const itemRows = this.db.prepare(`SELECT item_id,pack_key FROM public_skill_catalog_item
        WHERE service_id=? AND source_id=? AND layer='extension' AND item_id IN (${placeholders})`)
        .all(params.serviceId, this.config.sourceId, ...itemIds) as Array<{ item_id: string; pack_key: string | null }>;
      const found = new Set(itemRows.map((row) => row.item_id));
      if (itemIds.some((itemId) => !found.has(itemId))) throw new CatalogError("PUBLIC_SKILL_ITEM_NOT_FOUND");
      itemIds = itemRows.filter((row) => !row.pack_key || !packKeys.includes(row.pack_key)).map((row) => row.item_id).sort();
    }
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO public_skill_team_policy(service_id,source_id,team_id,updated_by,updated_at)
        VALUES (?,?,?,?,?) ON CONFLICT(service_id,source_id,team_id)
        DO UPDATE SET updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
        .run(params.serviceId, this.config.sourceId, params.teamId, params.updatedBy, now);
      this.db.prepare(`DELETE FROM public_skill_team_policy_selection WHERE service_id=? AND source_id=? AND team_id=?`)
        .run(params.serviceId, this.config.sourceId, params.teamId);
      const insert = this.db.prepare(`INSERT INTO public_skill_team_policy_selection
        (service_id,source_id,team_id,selection_type,selection_key) VALUES (?,?,?,?,?)`);
      for (const key of packKeys) insert.run(params.serviceId, this.config.sourceId, params.teamId, "pack", key);
      for (const itemId of itemIds) insert.run(params.serviceId, this.config.sourceId, params.teamId, "item", itemId);
    })();
    return this.getTeamPolicy(params.serviceId, params.teamId);
  }

  async snapshot(serviceId: string, itemId: string, expectedRevision?: string): Promise<PublicSkillSnapshot> {
    const item = this.get(serviceId, itemId);
    if (!item) throw new CatalogError("PUBLIC_SKILL_NOT_FOUND");
    if (expectedRevision && expectedRevision !== item.source_revision) throw new CatalogError("CATALOG_REVISION_CHANGED");
    return this.readSnapshot(serviceId, item);
  }

  createBootstrap(params: { serviceId: string; teamId: string; agentId: string; ownerUserId: string }) {
    if (!this.config.enabled || !this.config.autoInstallOnAgentCreate) return disabledJob(params);
    return this.createJob({ ...params, jobType: "agent_init", selectionKey: null,
      idempotencyKey: `agent-init:${params.agentId}`, items: this.effectiveItems(params.serviceId, params.teamId).items,
      firstAttemptAt: Date.now() + 5_000 });
  }

  createPackInstall(params: { serviceId: string; teamId: string; agentId: string; ownerUserId: string; packKey: string }) {
    if (!this.config.enabled) throw new CatalogError("PUBLIC_SKILL_CATALOG_DISABLED");
    const items = this.allItems(params.serviceId, { layer: "extension", packKey: params.packKey });
    if (!items.length) throw new CatalogError("PUBLIC_SKILL_PACK_NOT_FOUND");
    const fingerprint = createHash("sha256").update(items.map((item) => `${item.item_id}:${item.source_revision}:${item.content_hash}`).join("|")).digest("hex").slice(0, 16);
    return this.createJob({ ...params, jobType: "manual_pack", selectionKey: params.packKey,
      idempotencyKey: `manual-pack:${params.agentId}:${params.packKey}:${fingerprint}`, items, firstAttemptAt: 0 });
  }

  private createJob(params: {
    serviceId: string; teamId: string; agentId: string; ownerUserId: string;
    jobType: "agent_init" | "manual_pack"; selectionKey: string | null; idempotencyKey: string;
    items: PublicSkillItem[]; firstAttemptAt: number;
  }) {
    const prior = this.db.prepare(`SELECT job_id,status FROM public_skill_bootstrap_job
      WHERE service_id=? AND source_id=? AND idempotency_key=?`)
      .get(params.serviceId, this.config.sourceId, params.idempotencyKey) as { job_id: string; status: string } | undefined;
    if (prior) {
      if (params.jobType === "manual_pack" && ["completed", "empty"].includes(prior.status)) {
        const now = new Date().toISOString();
        this.db.transaction(() => {
          this.db.prepare(`UPDATE public_skill_bootstrap_item SET status='pending',attempts=0,installed_skill_id=NULL,
            last_error=NULL,next_attempt_at=0,updated_at=? WHERE job_id=?`).run(now, prior.job_id);
          this.db.prepare(`UPDATE public_skill_bootstrap_job SET status='pending',succeeded=0,failed=0,updated_at=? WHERE job_id=?`)
            .run(now, prior.job_id);
        })();
      }
      return this.bootstrapStatus(prior.job_id);
    }
    const now = new Date().toISOString();
    const jobId = `psb-${randomUUID()}`;
    const revisions = unique(params.items.map((item) => item.source_revision));
    const sourceRevision = revisions.length === 1 ? revisions[0] : null;
    const jobStatus = params.items.length === 0 ? "empty" : "pending";
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO public_skill_bootstrap_job
        (job_id,service_id,source_id,team_id,agent_id,owner_user_id,job_type,selection_key,idempotency_key,
         source_revision,status,total,succeeded,failed,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?)`).run(
        jobId, params.serviceId, this.config.sourceId, params.teamId, params.agentId, params.ownerUserId,
        params.jobType, params.selectionKey, params.idempotencyKey, sourceRevision, jobStatus, params.items.length, now, now,
      );
      const insert = this.db.prepare(`INSERT INTO public_skill_bootstrap_item
        (job_id,item_id,repo_path,name,description,source_revision,content_hash,status,attempts,next_attempt_at,updated_at)
        VALUES (?,?,?,?,?,?,?,'pending',0,?,?)`);
      for (const item of params.items) insert.run(jobId, item.item_id, item.repo_path, item.name, item.description,
        item.source_revision, item.content_hash, params.firstAttemptAt, now);
    })();
    return this.bootstrapStatus(jobId);
  }

  bootstrapStatus(jobId: string) {
    const job = this.db.prepare(`SELECT * FROM public_skill_bootstrap_job WHERE job_id=?`).get(jobId) as BootstrapJobRow | undefined;
    if (!job) return null;
    const items = this.db.prepare(`SELECT item_id,name,source_revision,status,attempts,installed_skill_id,last_error,updated_at
      FROM public_skill_bootstrap_item WHERE job_id=? ORDER BY name`).all(jobId);
    return { ...job, items };
  }

  bootstrapForAgent(serviceId: string, agentId: string) {
    const job = this.db.prepare(`SELECT job_id FROM public_skill_bootstrap_job
      WHERE service_id=? AND source_id=? AND agent_id=? AND job_type='agent_init' ORDER BY created_at DESC LIMIT 1`)
      .get(serviceId, this.config.sourceId, agentId) as { job_id: string } | undefined;
    return job ? this.bootstrapStatus(job.job_id) : null;
  }

  retryBootstrap(jobId: string) {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE public_skill_bootstrap_item SET status='pending',last_error=NULL,next_attempt_at=0,updated_at=?
      WHERE job_id=? AND status='failed'`).run(now, jobId);
    this.refreshJob(jobId);
    return this.bootstrapStatus(jobId);
  }

  async claimBootstrap(): Promise<null | { job: BootstrapJobRow; item: BootstrapItemRow; snapshot: PublicSkillSnapshot }> {
    const row = this.db.prepare(`SELECT i.*,j.service_id,j.source_id,j.team_id,j.agent_id,j.owner_user_id,
      j.job_type,j.selection_key,j.idempotency_key,j.status job_status,j.created_at job_created_at
      FROM public_skill_bootstrap_item i JOIN public_skill_bootstrap_job j ON j.job_id=i.job_id
      WHERE i.status='pending' AND i.next_attempt_at<=? AND j.status IN ('pending','running','partial')
      ORDER BY j.created_at,i.name LIMIT 1`).get(Date.now()) as (BootstrapItemRow & BootstrapJobRow) | undefined;
    if (!row) return null;
    const claimedAt = new Date().toISOString();
    const claimed = this.db.prepare(`UPDATE public_skill_bootstrap_item SET status='installing',attempts=attempts+1,updated_at=?
      WHERE job_id=? AND item_id=? AND status='pending'`).run(claimedAt, row.job_id, row.item_id);
    if (claimed.changes !== 1) return null;
    this.db.prepare(`UPDATE public_skill_bootstrap_job SET status='running',updated_at=? WHERE job_id=?`).run(claimedAt, row.job_id);
    try {
      const item: PublicSkillItem = {
        item_id: row.item_id, source_id: row.source_id, repo_path: row.repo_path, name: row.name,
        description: row.description, ...classifyRepoPath(row.repo_path), source_revision: row.source_revision,
        content_hash: row.content_hash, manifest: await this.readManifestFromSnapshot(row.service_id, row.source_revision, row.repo_path),
        total_bytes: 0, updated_at: row.updated_at,
      };
      return { job: row, item: row, snapshot: await this.readSnapshot(row.service_id, item) };
    } catch (error) {
      this.completeBootstrap({ jobId: row.job_id, itemId: row.item_id,
        error: `snapshot unavailable: ${error instanceof Error ? error.message : String(error)}` });
      return null;
    }
  }

  completeBootstrap(params: { jobId: string; itemId: string; skillId?: string; error?: string }) {
    const current = this.db.prepare(`SELECT attempts FROM public_skill_bootstrap_item WHERE job_id=? AND item_id=?`)
      .get(params.jobId, params.itemId) as { attempts: number } | undefined;
    if (!current) return null;
    const now = new Date().toISOString();
    if (!params.error) {
      this.db.prepare(`UPDATE public_skill_bootstrap_item SET status='installed',installed_skill_id=?,last_error=NULL,updated_at=?
        WHERE job_id=? AND item_id=?`).run(params.skillId ?? null, now, params.jobId, params.itemId);
    } else if (current.attempts < 3) {
      const delay = 1000 * 2 ** Math.max(0, current.attempts - 1);
      this.db.prepare(`UPDATE public_skill_bootstrap_item SET status='pending',last_error=?,next_attempt_at=?,updated_at=?
        WHERE job_id=? AND item_id=?`).run(params.error.slice(0, 1000), Date.now() + delay, now, params.jobId, params.itemId);
    } else {
      this.db.prepare(`UPDATE public_skill_bootstrap_item SET status='failed',last_error=?,updated_at=?
        WHERE job_id=? AND item_id=?`).run(params.error.slice(0, 1000), now, params.jobId, params.itemId);
    }
    this.refreshJob(params.jobId);
    return this.bootstrapStatus(params.jobId);
  }

  cancelAgent(serviceId: string, agentId: string): void {
    this.db.prepare(`UPDATE public_skill_bootstrap_job SET status='cancelled',updated_at=?
      WHERE service_id=? AND source_id=? AND agent_id=? AND status NOT IN ('completed','cancelled')`)
      .run(new Date().toISOString(), serviceId, this.config.sourceId, agentId);
  }

  private async performSync(serviceId: string): Promise<void> {
    const now = new Date().toISOString();
    this.upsertSource(serviceId, "syncing", null, now, false);
    const root = this.sourceRoot(serviceId);
    const staging = join(root, `staging-${randomUUID()}`);
    try {
      await mkdir(root, { recursive: true });
      const fetched = await this.fetcher.fetch(this.config.repoUrl, this.config.branch, staging);
      if (!fetched.version) throw new Error("empty repository");
      const parsed = await parsePublicSkillRepository(staging, this.config.sourceId, fetched.version);
      const snapshotDir = this.snapshotRoot(serviceId, fetched.version);
      await mkdir(resolve(snapshotDir, ".."), { recursive: true });
      try {
        await lstat(snapshotDir);
        await rm(staging, { recursive: true, force: true });
      } catch {
        await rename(staging, snapshotDir);
      }
      this.publishParsedRepository(serviceId, fetched.version, parsed);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      const current = this.getStatus(serviceId);
      const empty = /empty repository|remote branch .* not found|couldn't find remote ref/i.test(message);
      this.upsertSource(serviceId, empty && !current.active_commit ? "empty" : (current.active_commit ? "stale" : "failed"),
        current.active_commit, new Date().toISOString(), false, empty && !current.active_commit ? undefined : message);
      if (empty && !current.active_commit) log.info("public skill catalog is empty", { serviceId });
      else log.warn("public skill catalog sync failed", { serviceId, error: message });
    }
  }

  private publishParsedRepository(serviceId: string, revision: string, parsed: ParsedPublicSkillRepository): void {
    const now = new Date().toISOString();
    const existingItems = (this.db.prepare(`SELECT * FROM public_skill_catalog_item WHERE service_id=? AND source_id=?`)
      .all(serviceId, this.config.sourceId) as CatalogItemRow[]).map((row) => this.toItem(row));
    const existingByPartition = groupBy(existingItems, (item) => item.partition_key);
    const existingByName = new Map(existingItems.map((item) => [item.name, item]));
    const existingPartitions = this.db.prepare(`SELECT * FROM public_skill_catalog_partition WHERE service_id=? AND source_id=?`)
      .all(serviceId, this.config.sourceId) as PartitionRow[];
    const existingPartitionMap = new Map(existingPartitions.map((partition) => [partition.partition_key, partition]));
    const results = new Map(parsed.partitions.map((result) => [result.partition_key, result]));

    for (const old of existingPartitions) {
      if (old.layer === "extension" && !results.has(old.partition_key)) {
        results.set(old.partition_key, { partition_key: old.partition_key, layer: "extension", pack_key: old.pack_key,
          repo_path: old.repo_path, partition: { partition_key: old.partition_key, layer: "extension", pack_key: old.pack_key,
            repo_path: old.repo_path, items: [], document: null } });
      }
    }

    const successful = new Map<string, ParsedPartition>();
    for (const result of results.values()) {
      if (!result.partition) continue;
      const items = result.partition.items.map((item) => {
        const prior = existingByName.get(item.name);
        return prior ? { ...item, item_id: prior.item_id } : item;
      });
      successful.set(result.partition_key, { ...result.partition, items });
    }

    const proposed = new Map<string, PublicSkillItem[]>();
    for (const [key, items] of existingByPartition) proposed.set(key, items);
    for (const [key, partition] of successful) proposed.set(key, partition.items);
    const conflictingPartitions = duplicateNamePartitions(proposed);
    for (const partitionKey of conflictingPartitions) {
      const result = results.get(partitionKey);
      if (result?.partition) {
        result.error = "duplicate public skill name across catalog partitions";
        result.partition = undefined;
        successful.delete(partitionKey);
      }
    }

    const selected = new Map<string, PublicSkillItem[]>();
    for (const [key, items] of existingByPartition) selected.set(key, items);
    for (const [key, partition] of successful) selected.set(key, partition.items);
    const documents = new Map((this.documents(serviceId)).map((document) => [document.document_key, document]));
    for (const document of parsed.documents) documents.set(document.document_key, document);
    for (const [key, partition] of successful) {
      const documentKey = key === CORE_PARTITION ? "core" : `extension:${partition.pack_key}`;
      if (partition.document) documents.set(documentKey, partition.document);
      else documents.delete(documentKey);
      if (partition.layer === "extension" && partition.items.length === 0) documents.delete(documentKey);
    }

    const failures = Array.from(results.values()).filter((result) => !!result.error);
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM public_skill_catalog_item WHERE service_id=? AND source_id=?`).run(serviceId, this.config.sourceId);
      const insertItem = this.db.prepare(`INSERT INTO public_skill_catalog_item
        (service_id,source_id,item_id,repo_path,name,description,layer,pack_key,category_path,partition_key,
         source_revision,content_hash,manifest_json,total_bytes,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const items of selected.values()) for (const item of items) insertItem.run(
        serviceId, this.config.sourceId, item.item_id, item.repo_path, item.name, item.description, item.layer,
        item.pack_key, item.category_path, item.partition_key, item.source_revision, item.content_hash,
        JSON.stringify(item.manifest), item.total_bytes, item.updated_at, now);

      this.db.prepare(`DELETE FROM public_skill_catalog_document WHERE service_id=? AND source_id=?`).run(serviceId, this.config.sourceId);
      const insertDocument = this.db.prepare(`INSERT INTO public_skill_catalog_document
        (service_id,source_id,document_key,repo_path,title,content,source_revision,updated_at) VALUES (?,?,?,?,?,?,?,?)`);
      for (const document of documents.values()) insertDocument.run(serviceId, this.config.sourceId, document.document_key,
        document.repo_path, document.title, document.content, document.source_revision, now);

      for (const [key, result] of results) {
        const old = existingPartitionMap.get(key);
        const removed = !!result.partition && result.layer === "extension" && result.partition.items.length === 0 && !parsed.partitions.some((entry) => entry.partition_key === key);
        if (removed) {
          this.db.prepare(`DELETE FROM public_skill_catalog_partition WHERE service_id=? AND source_id=? AND partition_key=?`)
            .run(serviceId, this.config.sourceId, key);
          continue;
        }
        const accepted = successful.has(key);
        this.db.prepare(`INSERT INTO public_skill_catalog_partition
          (service_id,source_id,partition_key,layer,pack_key,repo_path,active_commit,status,last_error,last_sync_at,last_success_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(service_id,source_id,partition_key) DO UPDATE SET
          layer=excluded.layer,pack_key=excluded.pack_key,repo_path=excluded.repo_path,active_commit=excluded.active_commit,
          status=excluded.status,last_error=excluded.last_error,last_sync_at=excluded.last_sync_at,
          last_success_at=excluded.last_success_at,updated_at=excluded.updated_at`)
          .run(serviceId, this.config.sourceId, key, result.layer, result.pack_key, result.repo_path,
            accepted ? revision : old?.active_commit ?? null,
            accepted ? ((result.partition?.items.length ?? 0) ? "ready" : "empty") : (old?.active_commit ? "stale" : "failed"),
            result.error ?? null, now, accepted ? now : old?.last_success_at ?? null, now);
      }

      const allItems = Array.from(selected.values()).flat();
      const status = failures.length ? (allItems.length ? "partial" : "failed") : (allItems.length ? "ready" : "empty");
      this.upsertSource(serviceId, status, revision, now, failures.length === 0,
        failures.length ? failures.map((failure) => `${failure.partition_key}: ${failure.error}`).join("; ") : undefined);
    })();
    log.info("public skill catalog synced", { serviceId, commit: revision,
      items: Array.from(selected.values()).reduce((sum, items) => sum + items.length, 0), failures: failures.length });
  }

  private upsertSource(serviceId: string, status: string, activeCommit: string | null, at: string, success: boolean, error?: string): void {
    this.db.prepare(`INSERT INTO public_skill_catalog_source
      (service_id,source_id,source_name,repo_url,branch,active_commit,status,last_error,last_sync_at,last_success_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(service_id,source_id) DO UPDATE SET
      source_name=excluded.source_name,repo_url=excluded.repo_url,branch=excluded.branch,
      active_commit=COALESCE(excluded.active_commit,public_skill_catalog_source.active_commit),status=excluded.status,
      last_error=excluded.last_error,last_sync_at=excluded.last_sync_at,
      last_success_at=COALESCE(excluded.last_success_at,public_skill_catalog_source.last_success_at),updated_at=excluded.updated_at`)
      .run(serviceId, this.config.sourceId, this.config.sourceName, this.config.repoUrl, this.config.branch,
        activeCommit, status, error ?? null, at, success ? at : null, at);
  }

  private refreshJob(jobId: string): void {
    const counts = this.db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN status='installed' THEN 1 ELSE 0 END) succeeded,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
      SUM(CASE WHEN status IN ('pending','installing') THEN 1 ELSE 0 END) active
      FROM public_skill_bootstrap_item WHERE job_id=?`).get(jobId) as { total: number; succeeded: number; failed: number; active: number };
    const status = counts.total === 0 ? "empty" : counts.active > 0 ? "running" : counts.failed > 0 ? "partial" : "completed";
    this.db.prepare(`UPDATE public_skill_bootstrap_job SET status=?,total=?,succeeded=?,failed=?,updated_at=? WHERE job_id=?`)
      .run(status, counts.total, counts.succeeded || 0, counts.failed || 0, new Date().toISOString(), jobId);
  }

  private allItems(serviceId: string, filters: { layer?: string; packKey?: string } = {}): PublicSkillItem[] {
    const items: PublicSkillItem[] = [];
    for (let offset = 0; ; offset += 1000) {
      const page = this.list(serviceId, "", 1000, offset, filters);
      items.push(...page.items);
      if (offset + page.items.length >= page.total || page.items.length === 0) return items;
    }
  }

  private toItem(row: CatalogItemRow): PublicSkillItem {
    return { item_id: row.item_id, source_id: row.source_id, repo_path: row.repo_path, name: row.name,
      description: row.description, layer: row.layer as PublicSkillLayer, pack_key: row.pack_key,
      category_path: row.category_path, partition_key: row.partition_key, source_revision: row.source_revision,
      content_hash: row.content_hash, manifest: JSON.parse(row.manifest_json) as PublicSkillManifestEntry[],
      total_bytes: row.total_bytes, updated_at: row.updated_at };
  }

  private async readSnapshot(serviceId: string, item: PublicSkillItem): Promise<PublicSkillSnapshot> {
    const dir = resolveInside(this.snapshotRoot(serviceId, item.source_revision), item.repo_path);
    const content = await readFile(join(dir, "SKILL.md"), "utf8");
    const manifest = item.manifest.length ? item.manifest : await this.readManifestFromSnapshot(serviceId, item.source_revision, item.repo_path);
    const resources = await Promise.all(manifest.map(async (entry) => ({
      path: entry.path, content: (await readFile(resolveInside(dir, entry.path))).toString("base64"),
      encoding: "base64" as const, mime_type: entry.mime_type, is_executable: entry.is_executable,
    })));
    return { ...item, content, manifest, resources };
  }

  private async readManifestFromSnapshot(serviceId: string, revision: string, repoPath: string): Promise<PublicSkillManifestEntry[]> {
    return (await readSkillFiles(resolveInside(this.snapshotRoot(serviceId, revision), repoPath), repoPath)).manifest;
  }

  private sourceRoot(serviceId: string): string { return join(this.dataDir, "public-skill-catalog", safePart(serviceId), this.config.sourceId); }
  private snapshotRoot(serviceId: string, revision: string): string { return join(this.sourceRoot(serviceId), "snapshots", safePart(revision)); }
}

export class CatalogError extends Error {}

export async function parsePublicSkillRepository(checkout: string, sourceId: string, revision: string): Promise<ParsedPublicSkillRepository> {
  const documents: PublicSkillDocument[] = [];
  for (const spec of [
    { key: "root", path: "README.md", title: "公共技能库" },
    { key: "extensions", path: "extensions/README.md", title: "业务扩展技能" },
  ]) {
    const document = await readDocument(checkout, spec.key, spec.path, spec.title, revision, false);
    if (document) documents.push(document);
  }

  const partitions: PartitionResult[] = [];
  partitions.push(await parsePartition(checkout, sourceId, revision, {
    partitionKey: CORE_PARTITION, layer: "core", packKey: null, repoPath: "core", title: "核心基础技能",
  }));

  const extensionsRoot = join(checkout, "extensions");
  let extensionEntries: Dirent[] = [];
  try {
    const stat = await lstat(extensionsRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("extensions must be a regular directory");
    extensionEntries = await readdir(extensionsRoot, { withFileTypes: true });
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const entry of extensionEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "README.md" && entry.isFile()) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`invalid extensions entry: ${entry.name}`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.name)) throw new Error(`invalid extension pack name: ${entry.name}`);
    partitions.push(await parsePartition(checkout, sourceId, revision, {
      partitionKey: `extension:${entry.name}`, layer: "extension", packKey: entry.name,
      repoPath: `extensions/${entry.name}`, title: `${entry.name.toUpperCase()} 扩展技能`,
    }));
  }
  return { partitions, documents };
}

/** Strict helper used by tests and callers that need the complete repository to be valid. */
export async function parsePublicSkills(checkout: string, sourceId: string, revision: string): Promise<ParsedItem[]> {
  const parsed = await parsePublicSkillRepository(checkout, sourceId, revision);
  const failure = parsed.partitions.find((partition) => partition.error);
  if (failure) throw new Error(`${failure.partition_key}: ${failure.error}`);
  const items = parsed.partitions.flatMap((partition) => partition.partition?.items ?? []);
  const names = new Set<string>();
  for (const item of items) {
    if (names.has(item.name)) throw new Error(`duplicate public skill name: ${item.name}`);
    names.add(item.name);
  }
  return items;
}

async function parsePartition(
  checkout: string,
  sourceId: string,
  revision: string,
  spec: { partitionKey: string; layer: PublicSkillLayer; packKey: string | null; repoPath: string; title: string },
): Promise<PartitionResult> {
  try {
    const root = resolveInside(checkout, spec.repoPath);
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`${spec.repoPath} must be a regular directory`);
    const entries = await readdir(root, { withFileTypes: true });
    const items: ParsedItem[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "README.md" && entry.isFile()) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`invalid public skill entry: ${spec.repoPath}/${entry.name}`);
      const repoPath = `${spec.repoPath}/${entry.name}`;
      items.push(await parseSkillDirectory(join(root, entry.name), repoPath, sourceId, revision,
        spec.layer, spec.packKey, spec.repoPath, spec.partitionKey));
    }
    const names = new Set<string>();
    for (const item of items) {
      if (names.has(item.name)) throw new Error(`duplicate public skill name: ${item.name}`);
      names.add(item.name);
    }
    const documentKey = spec.partitionKey === CORE_PARTITION ? "core" : spec.partitionKey;
    const document = await readDocument(checkout, documentKey, `${spec.repoPath}/README.md`, spec.title, revision, false);
    return { ...snakeSpec(spec), partition: { partition_key: spec.partitionKey, layer: spec.layer,
      pack_key: spec.packKey, repo_path: spec.repoPath, items, document } };
  } catch (error) {
    return { ...snakeSpec(spec), error: error instanceof Error ? error.message : String(error) };
  }
}

function snakeSpec(spec: { partitionKey: string; layer: PublicSkillLayer; packKey: string | null; repoPath: string }) {
  return { partition_key: spec.partitionKey, layer: spec.layer, pack_key: spec.packKey, repo_path: spec.repoPath };
}

async function parseSkillDirectory(
  dir: string, repoPath: string, sourceId: string, revision: string, layer: PublicSkillLayer,
  packKey: string | null, categoryPath: string, partitionKey: string,
): Promise<ParsedItem> {
  const content = await readFile(join(dir, "SKILL.md"), "utf8");
  const frontmatter = parseFrontmatter(content);
  const directoryName = repoPath.split("/").at(-1) ?? "";
  if (frontmatter.name !== directoryName) throw new Error(`${repoPath}: directory name must equal frontmatter name`);
  const { manifest, total, contentHash } = await readSkillFiles(dir, repoPath);
  return {
    item_id: `pub-${createHash("sha256").update(`${sourceId}:${repoPath}`).digest("hex").slice(0, 16)}`,
    source_id: sourceId, repo_path: repoPath, name: frontmatter.name, description: frontmatter.description,
    layer, pack_key: packKey, category_path: categoryPath, partition_key: partitionKey,
    source_revision: revision, content_hash: contentHash, manifest, total_bytes: total,
    updated_at: new Date().toISOString(), absoluteDir: dir,
  };
}

async function readSkillFiles(dir: string, repoPath: string): Promise<{ manifest: PublicSkillManifestEntry[]; total: number; contentHash: string }> {
  const files = await walkRegularFiles(dir);
  const resources = files.filter((file) => file.relativePath !== "SKILL.md");
  if (resources.length > MAX_FILES) throw new Error(`${repoPath}: too many resource files`);
  let total = 0;
  const manifest: PublicSkillManifestEntry[] = [];
  const hash = createHash("sha256");
  for (const file of files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    const bytes = await readFile(file.absolutePath);
    if (bytes.length > MAX_FILE_BYTES) throw new Error(`${repoPath}/${file.relativePath}: resource too large`);
    if (bytes.subarray(0, 80).toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1")) {
      throw new Error(`${repoPath}/${file.relativePath}: Git LFS pointers are not supported`);
    }
    hash.update(file.relativePath).update("\0").update(file.executable ? "1" : "0").update("\0").update(bytes);
    if (file.relativePath !== "SKILL.md") {
      total += bytes.length;
      manifest.push({ path: file.relativePath, size_bytes: bytes.length,
        mime_type: mimeType(file.relativePath), is_executable: file.executable });
    }
  }
  if (total > MAX_TOTAL_BYTES) throw new Error(`${repoPath}: total resources exceed 50 MB`);
  return { manifest, total, contentHash: hash.digest("hex") };
}

async function readDocument(root: string, key: string, repoPath: string, title: string, revision: string, required: boolean): Promise<PublicSkillDocument | null> {
  try {
    const path = resolveInside(root, repoPath);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${repoPath}: document must be a regular file`);
    const bytes = await readFile(path);
    if (bytes.length > MAX_FILE_BYTES) throw new Error(`${repoPath}: document too large`);
    return { document_key: key, repo_path: repoPath, title, content: bytes.toString("utf8"),
      source_revision: revision, updated_at: new Date().toISOString() };
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseFrontmatter(content: string): { name: string; description: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new Error("SKILL.md must contain YAML frontmatter");
  const parsed = parseYaml(match[1]) as Record<string, unknown>;
  const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
  const description = typeof parsed?.description === "string" ? parsed.description.trim() : "";
  if (!name || name.length > 64 || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error("SKILL.md frontmatter.name is required and must be a lowercase slug <= 64 chars");
  }
  if (!description) throw new Error("SKILL.md frontmatter.description is required");
  return { name, description };
}

async function walkRegularFiles(root: string): Promise<Array<{ absolutePath: string; relativePath: string; executable: boolean }>> {
  const out: Array<{ absolutePath: string; relativePath: string; executable: boolean }> = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git") throw new Error("nested .git/submodules are not supported");
      const absolutePath = join(dir, entry.name);
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) throw new Error(`symlink is not supported: ${relative(root, absolutePath)}`);
      if (stat.isDirectory()) await walk(absolutePath);
      else if (stat.isFile()) out.push({ absolutePath,
        relativePath: relative(root, absolutePath).split(sep).join("/"), executable: (stat.mode & 0o111) !== 0 });
    }
  }
  await walk(root);
  if (!out.some((file) => file.relativePath === "SKILL.md")) throw new Error("SKILL.md is required");
  return out;
}

function classifyRepoPath(repoPath: string) {
  const parts = repoPath.split("/");
  if (parts[0] === "extensions" && parts[1]) return { layer: "extension" as const, pack_key: parts[1],
    category_path: `extensions/${parts[1]}`, partition_key: `extension:${parts[1]}` };
  return { layer: "core" as const, pack_key: null, category_path: "core", partition_key: CORE_PARTITION };
}

function duplicateNamePartitions(partitions: Map<string, PublicSkillItem[]>): Set<string> {
  const owners = new Map<string, string[]>();
  for (const [partition, items] of partitions) for (const item of items) {
    owners.set(item.name, [...(owners.get(item.name) ?? []), partition]);
  }
  return new Set(Array.from(owners.values()).filter((keys) => new Set(keys).size > 1).flat());
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) grouped.set(keyOf(item), [...(grouped.get(keyOf(item)) ?? []), item]);
  return grouped;
}

function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))].sort(); }
function resolveInside(root: string, child = ""): string {
  const base = resolve(root); const target = resolve(base, child);
  if (target !== base && !target.startsWith(base + sep)) throw new Error("path escapes public skill snapshot");
  return target;
}
function safePart(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "_"); }
function mimeType(path: string): string {
  const ext = extname(path).toLowerCase();
  return ({ ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json",
    ".yaml": "application/yaml", ".yml": "application/yaml", ".js": "text/javascript",
    ".ts": "text/typescript", ".py": "text/x-python", ".sh": "text/x-shellscript",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp" } as Record<string, string>)[ext] ?? "application/octet-stream";
}
function disabledJob(params: { serviceId: string; teamId: string; agentId: string }) {
  return { job_id: null, service_id: params.serviceId, team_id: params.teamId, agent_id: params.agentId,
    job_type: "agent_init", status: "disabled", total: 0, succeeded: 0, failed: 0, items: [] };
}

interface CatalogItemRow {
  source_id: string; item_id: string; repo_path: string; name: string; description: string;
  layer: string; pack_key: string | null; category_path: string; partition_key: string;
  source_revision: string; content_hash: string; manifest_json: string; total_bytes: number; updated_at: string;
}
interface PartitionRow {
  partition_key: string; layer: PublicSkillLayer; pack_key: string | null; repo_path: string;
  active_commit: string | null; last_success_at: string | null;
}
interface BootstrapJobRow {
  job_id: string; service_id: string; source_id: string; team_id: string; agent_id: string; owner_user_id: string;
  job_type: string; selection_key: string | null; idempotency_key: string; source_revision: string | null;
  status: string; total: number; succeeded: number; failed: number; created_at: string; updated_at: string;
}
interface BootstrapItemRow {
  job_id: string; item_id: string; repo_path: string; name: string; description: string; source_revision: string;
  content_hash: string; status: string; attempts: number; installed_skill_id?: string; last_error?: string; updated_at: string;
}
