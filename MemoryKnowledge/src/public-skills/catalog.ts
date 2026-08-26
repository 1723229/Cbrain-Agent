import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, readFile, readdir, rename, rm } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import { parse as parseYaml } from "yaml";

import type { PublicSkillCatalogConfig } from "../config.js";
import { GitSourceFetcher } from "../source-fetcher/git-fetcher.js";
import { createLogger } from "../logger.js";

const log = createLogger("public-skill-catalog");
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 100;

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

interface ParsedItem extends PublicSkillItem {
  absoluteDir: string;
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
    };
  }

  list(serviceId: string, query = "", limit = 100, offset = 0): { items: PublicSkillItem[]; total: number } {
    const needle = `%${query.trim()}%`;
    const args = [serviceId, this.config.sourceId, needle, needle];
    const total = Number((this.db.prepare(`SELECT COUNT(*) count FROM public_skill_catalog_item
      WHERE service_id=? AND source_id=? AND (name LIKE ? OR description LIKE ?)`)
      .get(...args) as { count: number }).count);
    const rows = this.db.prepare(`SELECT * FROM public_skill_catalog_item
      WHERE service_id=? AND source_id=? AND (name LIKE ? OR description LIKE ?)
      ORDER BY name LIMIT ? OFFSET ?`).all(...args, Math.min(Math.max(limit, 1), 1000), Math.max(offset, 0));
    return { items: rows.map((row) => this.toItem(row as CatalogItemRow)), total };
  }

  get(serviceId: string, itemId: string): PublicSkillItem | null {
    const row = this.db.prepare(`SELECT * FROM public_skill_catalog_item
      WHERE service_id=? AND source_id=? AND item_id=?`)
      .get(serviceId, this.config.sourceId, itemId) as CatalogItemRow | undefined;
    return row ? this.toItem(row) : null;
  }

  async snapshot(serviceId: string, itemId: string, expectedRevision?: string): Promise<PublicSkillSnapshot> {
    const item = this.get(serviceId, itemId);
    if (!item) throw new CatalogError("PUBLIC_SKILL_NOT_FOUND");
    if (expectedRevision && expectedRevision !== item.source_revision) {
      throw new CatalogError("CATALOG_REVISION_CHANGED");
    }
    return this.readSnapshot(serviceId, item);
  }

  createBootstrap(params: { serviceId: string; teamId: string; agentId: string; ownerUserId: string }) {
    if (!this.config.enabled || !this.config.autoInstallOnAgentCreate) {
      return { job_id: null, service_id: params.serviceId, team_id: params.teamId, agent_id: params.agentId,
        status: "disabled", total: 0, succeeded: 0, failed: 0, items: [] };
    }
    const prior = this.db.prepare(`SELECT * FROM public_skill_bootstrap_job
      WHERE service_id=? AND source_id=? AND agent_id=?`)
      .get(params.serviceId, this.config.sourceId, params.agentId) as BootstrapJobRow | undefined;
    if (prior) return this.bootstrapStatus(prior.job_id);

    const status = this.getStatus(params.serviceId);
    const items = status.active_commit ? this.list(params.serviceId, "", 1000, 0).items : [];
    const now = new Date().toISOString();
    const jobId = `psb-${randomUUID()}`;
    const jobStatus = items.length === 0 ? "empty" : "pending";
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO public_skill_bootstrap_job
        (job_id,service_id,source_id,team_id,agent_id,owner_user_id,source_revision,status,total,succeeded,failed,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,0,0,?,?)`).run(
        jobId, params.serviceId, this.config.sourceId, params.teamId, params.agentId,
        params.ownerUserId, status.active_commit, jobStatus, items.length, now, now,
      );
      const insert = this.db.prepare(`INSERT INTO public_skill_bootstrap_item
        (job_id,item_id,repo_path,name,description,content_hash,status,attempts,next_attempt_at,updated_at)
        VALUES (?,?,?,?,?,?,'pending',0,?,?)`);
      const firstAttemptAt = Date.now() + 5_000;
      for (const item of items) insert.run(jobId, item.item_id, item.repo_path, item.name, item.description, item.content_hash, firstAttemptAt, now);
    })();
    return this.bootstrapStatus(jobId);
  }

  bootstrapStatus(jobId: string) {
    const job = this.db.prepare(`SELECT * FROM public_skill_bootstrap_job WHERE job_id=?`).get(jobId) as BootstrapJobRow | undefined;
    if (!job) return null;
    const items = this.db.prepare(`SELECT item_id,name,status,attempts,installed_skill_id,last_error,updated_at
      FROM public_skill_bootstrap_item WHERE job_id=? ORDER BY name`).all(jobId);
    return { ...job, items };
  }

  bootstrapForAgent(serviceId: string, agentId: string) {
    const job = this.db.prepare(`SELECT job_id FROM public_skill_bootstrap_job WHERE service_id=? AND source_id=? AND agent_id=?`)
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
    const nowMs = Date.now();
    const row = this.db.prepare(`SELECT i.*,j.service_id,j.source_id,j.team_id,j.agent_id,j.owner_user_id,j.source_revision,j.status job_status
      FROM public_skill_bootstrap_item i JOIN public_skill_bootstrap_job j ON j.job_id=i.job_id
      WHERE i.status='pending' AND i.next_attempt_at<=? AND j.status IN ('pending','running','partial')
      ORDER BY j.created_at,i.name LIMIT 1`).get(nowMs) as (BootstrapItemRow & BootstrapJobRow) | undefined;
    if (!row) return null;
    const item: PublicSkillItem = {
      item_id: row.item_id,
      source_id: row.source_id,
      repo_path: row.repo_path,
      name: row.name,
      description: row.description,
      source_revision: row.source_revision ?? "",
      content_hash: row.content_hash,
      manifest: await this.readManifestFromSnapshot(row.service_id, row.source_revision ?? "", row.repo_path),
      total_bytes: 0,
      updated_at: row.updated_at,
    };
    const snapshot = await this.readSnapshot(row.service_id, item);
    const claimedAt = new Date().toISOString();
    const claimed = this.db.prepare(`UPDATE public_skill_bootstrap_item SET status='installing',attempts=attempts+1,updated_at=?
      WHERE job_id=? AND item_id=? AND status='pending'`).run(claimedAt, row.job_id, row.item_id);
    if (claimed.changes !== 1) return null;
    this.db.prepare(`UPDATE public_skill_bootstrap_job SET status='running',updated_at=? WHERE job_id=?`)
      .run(claimedAt, row.job_id);
    return { job: row, item: row, snapshot };
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
      const parsed = await parsePublicSkills(staging, this.config.sourceId, fetched.version);
      const snapshotDir = this.snapshotRoot(serviceId, fetched.version);
      await mkdir(resolve(snapshotDir, ".."), { recursive: true });
      try {
        await lstat(snapshotDir);
        await rm(staging, { recursive: true, force: true });
      } catch {
        await rename(staging, snapshotDir);
      }
      const publishedAt = new Date().toISOString();
      this.db.transaction(() => {
        this.db.prepare(`DELETE FROM public_skill_catalog_item WHERE service_id=? AND source_id=?`)
          .run(serviceId, this.config.sourceId);
        const insert = this.db.prepare(`INSERT INTO public_skill_catalog_item
          (service_id,source_id,item_id,repo_path,name,description,source_revision,content_hash,manifest_json,total_bytes,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
        for (const item of parsed) {
          insert.run(serviceId, this.config.sourceId, item.item_id, item.repo_path, item.name, item.description,
            fetched.version, item.content_hash, JSON.stringify(item.manifest), item.total_bytes, publishedAt, publishedAt);
        }
        this.upsertSource(serviceId, parsed.length ? "ready" : "empty", fetched.version, publishedAt, true);
      })();
      log.info("public skill catalog synced", { serviceId, commit: fetched.version, items: parsed.length });
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      const current = this.getStatus(serviceId);
      const empty = /empty repository|remote branch .* not found|couldn't find remote ref/i.test(message);
      this.upsertSource(serviceId, empty && !current.active_commit ? "empty" : (current.active_commit ? "stale" : "failed"), current.active_commit, new Date().toISOString(), false, empty && !current.active_commit ? undefined : message);
      if (empty && !current.active_commit) log.info("public skill catalog is empty", { serviceId });
      else log.warn("public skill catalog sync failed", { serviceId, error: message });
    }
  }

  private upsertSource(serviceId: string, status: string, activeCommit: string | null, at: string, success: boolean, error?: string): void {
    this.db.prepare(`INSERT INTO public_skill_catalog_source
      (service_id,source_id,source_name,repo_url,branch,active_commit,status,last_error,last_sync_at,last_success_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(service_id,source_id) DO UPDATE SET source_name=excluded.source_name,repo_url=excluded.repo_url,
      branch=excluded.branch,active_commit=COALESCE(excluded.active_commit,public_skill_catalog_source.active_commit),
      status=excluded.status,last_error=excluded.last_error,last_sync_at=excluded.last_sync_at,
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

  private toItem(row: CatalogItemRow): PublicSkillItem {
    return { item_id: row.item_id, source_id: row.source_id, repo_path: row.repo_path, name: row.name,
      description: row.description, source_revision: row.source_revision, content_hash: row.content_hash,
      manifest: JSON.parse(row.manifest_json) as PublicSkillManifestEntry[], total_bytes: row.total_bytes, updated_at: row.updated_at };
  }

  private async readSnapshot(serviceId: string, item: PublicSkillItem): Promise<PublicSkillSnapshot> {
    const dir = resolveInside(this.snapshotRoot(serviceId, item.source_revision), item.repo_path);
    const content = await readFile(join(dir, "SKILL.md"), "utf8");
    const manifest = item.manifest.length ? item.manifest : await this.readManifestFromSnapshot(serviceId, item.source_revision, item.repo_path);
    const resources = await Promise.all(manifest.map(async (entry) => ({
      path: entry.path,
      content: (await readFile(resolveInside(dir, entry.path))).toString("base64"),
      encoding: "base64" as const,
      mime_type: entry.mime_type,
      is_executable: entry.is_executable,
    })));
    return { ...item, content, manifest, resources };
  }

  private async readManifestFromSnapshot(serviceId: string, revision: string, repoPath: string): Promise<PublicSkillManifestEntry[]> {
    const dir = resolveInside(this.snapshotRoot(serviceId, revision), repoPath);
    return (await parseSkillDirectory(dir, repoPath, this.config.sourceId, revision)).manifest;
  }

  private sourceRoot(serviceId: string): string { return join(this.dataDir, "public-skill-catalog", safePart(serviceId), this.config.sourceId); }
  private snapshotRoot(serviceId: string, revision: string): string { return join(this.sourceRoot(serviceId), "snapshots", safePart(revision)); }
}

export class CatalogError extends Error {}

export async function parsePublicSkills(checkout: string, sourceId: string, revision: string): Promise<ParsedItem[]> {
  const skillsRoot = join(checkout, "skills");
  let entries;
  try { entries = await readdir(skillsRoot, { withFileTypes: true }); } catch { return []; }
  const items: ParsedItem[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`invalid public skill directory: ${entry.name}`);
    const repoPath = `skills/${entry.name}`;
    items.push(await parseSkillDirectory(join(skillsRoot, entry.name), repoPath, sourceId, revision));
  }
  const names = new Set<string>();
  for (const item of items) {
    if (names.has(item.name)) throw new Error(`duplicate public skill name: ${item.name}`);
    names.add(item.name);
  }
  return items;
}

async function parseSkillDirectory(dir: string, repoPath: string, sourceId: string, revision: string): Promise<ParsedItem> {
  const main = join(dir, "SKILL.md");
  const content = await readFile(main, "utf8");
  const frontmatter = parseFrontmatter(content);
  const directoryName = repoPath.split("/").at(-1) ?? "";
  if (frontmatter.name !== directoryName) throw new Error(`${repoPath}: directory name must equal frontmatter name`);
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
    hash.update(file.relativePath).update("\0").update(bytes);
    if (file.relativePath !== "SKILL.md") {
      total += bytes.length;
      manifest.push({ path: file.relativePath, size_bytes: bytes.length, mime_type: mimeType(file.relativePath), is_executable: file.executable });
    }
  }
  if (total > MAX_TOTAL_BYTES) throw new Error(`${repoPath}: total resources exceed 50 MB`);
  return { item_id: `pub-${createHash("sha256").update(`${sourceId}:${repoPath}`).digest("hex").slice(0, 16)}`,
    source_id: sourceId, repo_path: repoPath, name: frontmatter.name, description: frontmatter.description,
    source_revision: revision, content_hash: hash.digest("hex"), manifest, total_bytes: total,
    updated_at: new Date().toISOString(), absoluteDir: dir };
}

function parseFrontmatter(content: string): { name: string; description: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new Error("SKILL.md must contain YAML frontmatter");
  const parsed = parseYaml(match[1]) as Record<string, unknown>;
  const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
  const description = typeof parsed?.description === "string" ? parsed.description.trim() : "";
  if (!name || name.length > 64) throw new Error("SKILL.md frontmatter.name is required and must be <= 64 chars");
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
      else if (stat.isFile()) out.push({ absolutePath, relativePath: relative(root, absolutePath).split(sep).join("/"), executable: (stat.mode & 0o111) !== 0 });
    }
  }
  await walk(root);
  if (!out.some((file) => file.relativePath === "SKILL.md")) throw new Error("SKILL.md is required");
  return out;
}

function resolveInside(root: string, child = ""): string {
  const base = resolve(root);
  const target = resolve(base, child);
  if (target !== base && !target.startsWith(base + sep)) throw new Error("path escapes public skill snapshot");
  return target;
}

function safePart(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "_"); }
function mimeType(path: string): string {
  const ext = extname(path).toLowerCase();
  return ({ ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json", ".yaml": "application/yaml", ".yml": "application/yaml", ".js": "text/javascript", ".ts": "text/typescript", ".py": "text/x-python", ".sh": "text/x-shellscript" } as Record<string, string>)[ext] ?? "application/octet-stream";
}

interface CatalogItemRow { source_id: string; item_id: string; repo_path: string; name: string; description: string; source_revision: string; content_hash: string; manifest_json: string; total_bytes: number; updated_at: string }
interface BootstrapJobRow { job_id: string; service_id: string; source_id: string; team_id: string; agent_id: string; owner_user_id: string; source_revision: string | null; status: string; total: number; succeeded: number; failed: number; created_at: string; updated_at: string }
interface BootstrapItemRow { job_id: string; item_id: string; repo_path: string; name: string; description: string; content_hash: string; status: string; attempts: number; installed_skill_id?: string; last_error?: string; updated_at: string }
