/**
 * Drizzle client initialization — creates better-sqlite3 Database + drizzle wrapper.
 *
 * Synchronous driver, matches existing store call patterns.
 */

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

export interface CreateDbOptions {
  /** Path to SQLite file. Use ":memory:" for in-memory DB. */
  path: string;
  /** Whether to run migrations (CREATE TABLE IF NOT EXISTS) on init. Default true. */
  autoMigrate?: boolean;
}

/**
 * Create a Drizzle-wrapped better-sqlite3 database.
 * Sets WAL mode + busy_timeout for production safety.
 */
export function createDb(opts: CreateDbOptions): { db: Db; raw: Database.Database } {
  if (opts.path !== ":memory:") {
    mkdirSync(dirname(opts.path), { recursive: true });
  }

  const raw = new Database(opts.path);
  raw.pragma("journal_mode = WAL");
  raw.pragma("busy_timeout = 5000");

  const db = drizzle(raw, { schema });

  if (opts.autoMigrate !== false) {
    migrate(db, raw);
  }

  return { db, raw };
}

/**
 * Run idempotent CREATE TABLE IF NOT EXISTS for all 4 tables + indexes.
 * Uses raw SQL for partial unique indexes (Drizzle schema definition generates them
 * via drizzle-kit, but for runtime we ensure tables exist).
 */
export function migrate(_db: Db, raw: Database.Database): void {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_code_graph (
      code_graph_id   TEXT PRIMARY KEY,
      service_id      TEXT NOT NULL,
      team_id         TEXT NOT NULL,
      repo_name       TEXT NOT NULL DEFAULT '',
      repo_url        TEXT NOT NULL,
      branch          TEXT NOT NULL,
      commit_hash     TEXT,
      owner_user_id   TEXT,
      user_id         TEXT,
      agent_id        TEXT,
      task_id         TEXT,
      visibility      TEXT NOT NULL DEFAULT 'team',
      status          TEXT NOT NULL DEFAULT 'pending',
      internal_status TEXT,
      sync_error      TEXT,
      stats_json      TEXT,
      version         INTEGER NOT NULL DEFAULT 0,
      last_sync_at    TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      deleted_at      TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_kcg_team_repo_branch
      ON knowledge_code_graph(service_id, team_id, repo_url, branch)
      WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_kcg_team_status
      ON knowledge_code_graph(service_id, team_id, status);

    CREATE TABLE IF NOT EXISTS knowledge_wiki (
      wiki_id         TEXT PRIMARY KEY,
      service_id      TEXT NOT NULL,
      team_id         TEXT NOT NULL,
      name            TEXT NOT NULL,
      source_type     TEXT,
      source_url      TEXT,
      owner_user_id   TEXT,
      user_id         TEXT,
      agent_id        TEXT,
      task_id         TEXT,
      visibility      TEXT NOT NULL DEFAULT 'team',
      status          TEXT NOT NULL DEFAULT 'draft',
      internal_status TEXT,
      sync_error      TEXT,
      page_count      INTEGER,
      version         INTEGER NOT NULL DEFAULT 0,
      last_sync_at    TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      deleted_at      TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_kwiki_team_name
      ON knowledge_wiki(service_id, team_id, name)
      WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_kwiki_team_status
      ON knowledge_wiki(service_id, team_id, status);

    CREATE TABLE IF NOT EXISTS knowledge_wiki_audit (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      wiki_id    TEXT NOT NULL,
      service_id TEXT,
      version    INTEGER NOT NULL DEFAULT 0,
      action     TEXT NOT NULL,
      user_id    TEXT,
      agent_id   TEXT,
      detail     TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_kwa_wiki_version
      ON knowledge_wiki_audit(wiki_id, version DESC);

    CREATE TABLE IF NOT EXISTS knowledge_code_graph_audit (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      code_graph_id TEXT NOT NULL,
      service_id    TEXT,
      version       INTEGER NOT NULL DEFAULT 0,
      action        TEXT NOT NULL,
      user_id       TEXT,
      agent_id      TEXT,
      detail        TEXT,
      created_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_kcga_cg_version
      ON knowledge_code_graph_audit(code_graph_id, version DESC);

    CREATE TABLE IF NOT EXISTS llm_binding (
      service_id     TEXT PRIMARY KEY,
      mode           TEXT NOT NULL DEFAULT 'proxy',
      proxy_base_url TEXT,
      api_key        TEXT,
      model          TEXT,
      base_url       TEXT,
      enabled        INTEGER NOT NULL DEFAULT 1,
      updated_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS public_skill_catalog_source (
      service_id       TEXT NOT NULL,
      source_id        TEXT NOT NULL,
      source_name      TEXT NOT NULL,
      repo_url         TEXT NOT NULL,
      branch           TEXT NOT NULL,
      active_commit    TEXT,
      status           TEXT NOT NULL DEFAULT 'empty',
      last_error       TEXT,
      last_sync_at     TEXT,
      last_success_at  TEXT,
      updated_at       TEXT NOT NULL,
      PRIMARY KEY(service_id, source_id)
    );

    CREATE TABLE IF NOT EXISTS public_skill_catalog_item (
      service_id       TEXT NOT NULL,
      source_id        TEXT NOT NULL,
      item_id          TEXT NOT NULL,
      repo_path        TEXT NOT NULL,
      name             TEXT NOT NULL,
      description      TEXT NOT NULL,
      layer            TEXT NOT NULL DEFAULT 'core',
      pack_key         TEXT,
      category_path    TEXT NOT NULL DEFAULT 'core',
      partition_key    TEXT NOT NULL DEFAULT 'core',
      source_revision  TEXT NOT NULL,
      content_hash     TEXT NOT NULL,
      manifest_json    TEXT NOT NULL,
      total_bytes      INTEGER NOT NULL,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      PRIMARY KEY(service_id, source_id, item_id),
      UNIQUE(service_id, source_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_public_skill_catalog_item_search
      ON public_skill_catalog_item(service_id, source_id, name);

    CREATE TABLE IF NOT EXISTS public_skill_catalog_partition (
      service_id       TEXT NOT NULL,
      source_id        TEXT NOT NULL,
      partition_key    TEXT NOT NULL,
      layer            TEXT NOT NULL,
      pack_key         TEXT,
      repo_path        TEXT NOT NULL,
      active_commit    TEXT,
      status           TEXT NOT NULL DEFAULT 'empty',
      last_error       TEXT,
      last_sync_at     TEXT,
      last_success_at  TEXT,
      updated_at       TEXT NOT NULL,
      PRIMARY KEY(service_id, source_id, partition_key)
    );

    CREATE TABLE IF NOT EXISTS public_skill_catalog_document (
      service_id       TEXT NOT NULL,
      source_id        TEXT NOT NULL,
      document_key     TEXT NOT NULL,
      repo_path        TEXT NOT NULL,
      title            TEXT NOT NULL,
      content          TEXT NOT NULL,
      source_revision  TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      PRIMARY KEY(service_id, source_id, document_key)
    );

    CREATE TABLE IF NOT EXISTS public_skill_team_policy (
      service_id       TEXT NOT NULL,
      source_id        TEXT NOT NULL,
      team_id          TEXT NOT NULL,
      updated_by       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      PRIMARY KEY(service_id, source_id, team_id)
    );

    CREATE TABLE IF NOT EXISTS public_skill_team_policy_selection (
      service_id       TEXT NOT NULL,
      source_id        TEXT NOT NULL,
      team_id          TEXT NOT NULL,
      selection_type   TEXT NOT NULL,
      selection_key    TEXT NOT NULL,
      PRIMARY KEY(service_id, source_id, team_id, selection_type, selection_key)
    );

    CREATE TABLE IF NOT EXISTS public_skill_bootstrap_job (
      job_id            TEXT PRIMARY KEY,
      service_id        TEXT NOT NULL,
      source_id         TEXT NOT NULL,
      team_id           TEXT NOT NULL,
      agent_id          TEXT NOT NULL,
      owner_user_id     TEXT NOT NULL,
      job_type          TEXT NOT NULL,
      selection_key     TEXT,
      idempotency_key   TEXT NOT NULL,
      source_revision   TEXT,
      status            TEXT NOT NULL,
      total             INTEGER NOT NULL DEFAULT 0,
      succeeded         INTEGER NOT NULL DEFAULT 0,
      failed            INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      UNIQUE(service_id, source_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS public_skill_bootstrap_item (
      job_id             TEXT NOT NULL,
      item_id            TEXT NOT NULL,
      repo_path          TEXT NOT NULL,
      name               TEXT NOT NULL,
      description        TEXT NOT NULL,
      source_revision    TEXT NOT NULL,
      content_hash       TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'pending',
      attempts           INTEGER NOT NULL DEFAULT 0,
      installed_skill_id TEXT,
      last_error         TEXT,
      next_attempt_at    INTEGER NOT NULL DEFAULT 0,
      updated_at         TEXT NOT NULL,
      PRIMARY KEY(job_id, item_id)
    );

    CREATE INDEX IF NOT EXISTS idx_public_skill_bootstrap_due
      ON public_skill_bootstrap_item(status, next_attempt_at);
  `);

  // Column migrations — SQLite ALTER TABLE ADD COLUMN is not idempotent,
  // so we check PRAGMA table_info first.
  addColumnIfMissing(raw, "knowledge_code_graph", "service_url", "TEXT");
  addColumnIfMissing(raw, "knowledge_code_graph", "summary", "TEXT");
  addColumnIfMissing(raw, "knowledge_wiki", "service_url", "TEXT");
  addColumnIfMissing(raw, "knowledge_wiki", "summary", "TEXT");
  // service_id on audit tables is nullable → safe to add to existing dev DBs.
  addColumnIfMissing(raw, "knowledge_wiki_audit", "service_id", "TEXT");
  addColumnIfMissing(raw, "knowledge_code_graph_audit", "service_id", "TEXT");
  addColumnIfMissing(raw, "public_skill_catalog_item", "layer", "TEXT NOT NULL DEFAULT 'core'");
  addColumnIfMissing(raw, "public_skill_catalog_item", "pack_key", "TEXT");
  addColumnIfMissing(raw, "public_skill_catalog_item", "category_path", "TEXT NOT NULL DEFAULT 'core'");
  addColumnIfMissing(raw, "public_skill_catalog_item", "partition_key", "TEXT NOT NULL DEFAULT 'core'");
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_public_skill_catalog_item_partition
    ON public_skill_catalog_item(service_id, source_id, partition_key, name);`);
  migratePublicSkillJobs(raw);
}

/** Replace the original one-job-per-Agent schema with typed, idempotent install jobs. */
function migratePublicSkillJobs(raw: Database.Database): void {
  const cols = raw.pragma("table_info(public_skill_bootstrap_job)") as Array<{ name: string }>;
  if (cols.some((column) => column.name === "job_type")) return;
  raw.transaction(() => raw.exec(`
    ALTER TABLE public_skill_bootstrap_job RENAME TO public_skill_bootstrap_job_legacy;
    ALTER TABLE public_skill_bootstrap_item RENAME TO public_skill_bootstrap_item_legacy;

    CREATE TABLE public_skill_bootstrap_job (
      job_id            TEXT PRIMARY KEY,
      service_id        TEXT NOT NULL,
      source_id         TEXT NOT NULL,
      team_id           TEXT NOT NULL,
      agent_id          TEXT NOT NULL,
      owner_user_id     TEXT NOT NULL,
      job_type          TEXT NOT NULL,
      selection_key     TEXT,
      idempotency_key   TEXT NOT NULL,
      source_revision   TEXT,
      status            TEXT NOT NULL,
      total             INTEGER NOT NULL DEFAULT 0,
      succeeded         INTEGER NOT NULL DEFAULT 0,
      failed            INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      UNIQUE(service_id, source_id, idempotency_key)
    );

    CREATE TABLE public_skill_bootstrap_item (
      job_id             TEXT NOT NULL,
      item_id            TEXT NOT NULL,
      repo_path          TEXT NOT NULL,
      name               TEXT NOT NULL,
      description        TEXT NOT NULL,
      source_revision    TEXT NOT NULL,
      content_hash       TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'pending',
      attempts           INTEGER NOT NULL DEFAULT 0,
      installed_skill_id TEXT,
      last_error         TEXT,
      next_attempt_at    INTEGER NOT NULL DEFAULT 0,
      updated_at         TEXT NOT NULL,
      PRIMARY KEY(job_id, item_id)
    );

    INSERT INTO public_skill_bootstrap_job
      (job_id,service_id,source_id,team_id,agent_id,owner_user_id,job_type,selection_key,idempotency_key,
       source_revision,status,total,succeeded,failed,created_at,updated_at)
    SELECT job_id,service_id,source_id,team_id,agent_id,owner_user_id,'agent_init',NULL,
      'agent-init:' || agent_id,source_revision,status,total,succeeded,failed,created_at,updated_at
      FROM public_skill_bootstrap_job_legacy;

    INSERT INTO public_skill_bootstrap_item
      (job_id,item_id,repo_path,name,description,source_revision,content_hash,status,attempts,
       installed_skill_id,last_error,next_attempt_at,updated_at)
    SELECT i.job_id,i.item_id,i.repo_path,i.name,i.description,COALESCE(j.source_revision,''),i.content_hash,
      i.status,i.attempts,i.installed_skill_id,i.last_error,i.next_attempt_at,i.updated_at
      FROM public_skill_bootstrap_item_legacy i
      JOIN public_skill_bootstrap_job_legacy j ON j.job_id=i.job_id;

    DROP TABLE public_skill_bootstrap_item_legacy;
    DROP TABLE public_skill_bootstrap_job_legacy;

    CREATE INDEX IF NOT EXISTS idx_public_skill_bootstrap_due
      ON public_skill_bootstrap_item(status, next_attempt_at);
  `))();
}

/** Add a column to a table if it doesn't already exist. SQLite-safe. */
function addColumnIfMissing(
  raw: Database.Database,
  table: string,
  column: string,
  type: string,
): void {
  const cols = raw.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
  }
}
