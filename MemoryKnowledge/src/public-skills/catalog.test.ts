import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { createDb } from "../db/client.js";
import { parsePublicSkillRepository, parsePublicSkills, PublicSkillCatalog } from "./catalog.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("PublicSkillCatalog", () => {
  it("parses core and extension Skills with documents and supporting resources", async () => {
    const root = await fixture();
    await writeFile(join(root, "README.md"), "# Shared Skills\n");
    await writeFile(join(root, "core", "README.md"), "# Core\n");
    await writeSkill(root, "core/database-review", "database-review", "Review database changes", {
      "scripts/check.sh": "echo ok\n",
    });
    await writeFile(join(root, "extensions", "README.md"), "# Extensions\n");
    await mkdir(join(root, "extensions", "aps"), { recursive: true });
    await writeFile(join(root, "extensions", "aps", "README.md"), "# APS\n");
    await writeSkill(root, "extensions/aps/aps-scheduler", "aps-scheduler", "Plan a schedule");

    const parsed = await parsePublicSkillRepository(root, "shared-skills", "abc123");
    const items = await parsePublicSkills(root, "shared-skills", "abc123");

    expect(parsed.partitions.map((partition) => partition.partition_key)).toEqual(["core", "extension:aps"]);
    expect(parsed.documents.map((document) => document.document_key)).toEqual(["root", "extensions"]);
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "database-review", layer: "core", partition_key: "core" }),
      expect.objectContaining({ name: "aps-scheduler", layer: "extension", pack_key: "aps" }),
    ]));
    expect(items.find((item) => item.name === "database-review")?.manifest)
      .toEqual([expect.objectContaining({ path: "scripts/check.sh" })]);
  });

  it.skipIf(process.platform === "win32")("includes executable metadata in the content fingerprint", async () => {
    const root = await fixture();
    await writeSkill(root, "core/scripted", "scripted", "Scripted", { "scripts/check.sh": "echo ok\n" });
    const script = join(root, "core", "scripted", "scripts", "check.sh");
    const executable = (await parsePublicSkills(root, "shared-skills", "rev-1"))[0];
    await import("node:fs/promises").then(({ chmod }) => chmod(script, 0o644));
    const regular = (await parsePublicSkills(root, "shared-skills", "rev-2"))[0];
    expect(executable.content_hash).not.toBe(regular.content_hash);
  });

  it("rejects a Skill whose directory differs from frontmatter", async () => {
    const root = await fixture();
    await writeSkill(root, "core/wrong-name", "actual-name", "x");
    await expect(parsePublicSkills(root, "shared-skills", "abc")).rejects.toThrow(/directory name/);
  });

  it("rejects duplicate names across different catalog directories", async () => {
    const root = await fixture();
    await writeSkill(root, "core/shared-name", "shared-name", "core");
    await writeSkill(root, "extensions/aps/shared-name", "shared-name", "extension");
    await expect(parsePublicSkills(root, "shared-skills", "abc")).rejects.toThrow(/duplicate public skill name/);
  });

  it("reports one invalid extension partition without invalidating the others", async () => {
    const root = await fixture();
    await writeSkill(root, "core/grill-me", "grill-me", "Clarify plans");
    await writeSkill(root, "extensions/aps/aps-scheduler", "aps-scheduler", "Plan a schedule");
    await writeSkill(root, "extensions/mes/wrong", "mes-quality", "Manage quality");

    const parsed = await parsePublicSkillRepository(root, "shared-skills", "abc");

    expect(parsed.partitions.find((partition) => partition.partition_key === "core")?.partition?.items).toHaveLength(1);
    expect(parsed.partitions.find((partition) => partition.partition_key === "extension:aps")?.partition?.items).toHaveLength(1);
    expect(parsed.partitions.find((partition) => partition.partition_key === "extension:mes")?.error).toMatch(/directory name/);
  });

  it.skipIf(process.platform === "win32")("rejects symlink resources", async () => {
    const root = await fixture();
    await writeSkill(root, "core/unsafe", "unsafe", "x");
    await symlink(join(root, "core", "unsafe", "SKILL.md"), join(root, "core", "unsafe", "linked.md"));
    await expect(parsePublicSkills(root, "shared-skills", "abc")).rejects.toThrow(/symlink/);
  });

  it("rejects oversized resources, Git LFS pointers, and unexpected partition files", async () => {
    const oversized = await fixture();
    await writeSkill(oversized, "core/oversized", "oversized", "x");
    await writeFile(join(oversized, "core", "oversized", "large.bin"), Buffer.alloc(5 * 1024 * 1024 + 1));
    await expect(parsePublicSkills(oversized, "shared-skills", "abc")).rejects.toThrow(/resource too large/);

    const lfs = await fixture();
    await writeSkill(lfs, "core/lfs", "lfs", "x", {
      "assets/model.bin": "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 10\n",
    });
    await expect(parsePublicSkills(lfs, "shared-skills", "abc")).rejects.toThrow(/Git LFS/);

    const unexpected = await fixture();
    await writeFile(join(unexpected, "core", "notes.txt"), "not a Skill");
    await expect(parsePublicSkills(unexpected, "shared-skills", "abc")).rejects.toThrow(/invalid public skill entry/);
  });

  it("keeps a failed partition last-good while publishing valid partitions", async () => {
    const { raw } = createDb({ path: ":memory:" });
    const dataDir = await fixture();
    const catalog = new PublicSkillCatalog(raw, dataDir, config());
    const first = await fixture();
    await writeSkill(first, "core/grill-me", "grill-me", "v1");
    await writeSkill(first, "extensions/mes/mes-quality", "mes-quality", "v1");
    publish(catalog, "default", "rev-1", await parsePublicSkillRepository(first, "shared-skills", "rev-1"));

    const second = await fixture();
    await writeSkill(second, "core/grill-me", "grill-me", "v2");
    await writeSkill(second, "extensions/mes/wrong", "mes-quality", "broken");
    publish(catalog, "default", "rev-2", await parsePublicSkillRepository(second, "shared-skills", "rev-2"));

    const items = catalog.list("default", "", 100, 0).items;
    expect(items.find((item) => item.name === "grill-me")?.source_revision).toBe("rev-2");
    expect(items.find((item) => item.name === "mes-quality")?.source_revision).toBe("rev-1");
    expect(catalog.getStatus("default")).toMatchObject({ status: "partial" });
    expect((catalog.getStatus("default").partitions as Array<Record<string, unknown>>)
      .find((partition) => partition.partition_key === "extension:mes"))
      .toMatchObject({ status: "stale", active_commit: "rev-1" });
  });

  it("rejects only partitions involved in a cross-partition name collision", async () => {
    const { raw } = createDb({ path: ":memory:" });
    const catalog = new PublicSkillCatalog(raw, await fixture(), config());
    const first = await fixture();
    await writeSkill(first, "core/core-alpha", "core-alpha", "core v1");
    await writeSkill(first, "extensions/aps/aps-beta", "aps-beta", "aps v1");
    await writeSkill(first, "extensions/mes/mes-gamma", "mes-gamma", "mes v1");
    publish(catalog, "default", "rev-1", await parsePublicSkillRepository(first, "shared-skills", "rev-1"));

    const second = await fixture();
    await writeSkill(second, "core/shared-name", "shared-name", "core collision");
    await writeSkill(second, "extensions/aps/shared-name", "shared-name", "aps collision");
    await writeSkill(second, "extensions/mes/mes-gamma", "mes-gamma", "mes v2");
    publish(catalog, "default", "rev-2", await parsePublicSkillRepository(second, "shared-skills", "rev-2"));

    expect(catalog.list("default", "", 100, 0).items.map((item) => [item.name, item.source_revision])).toEqual([
      ["core-alpha", "rev-1"], ["aps-beta", "rev-1"], ["mes-gamma", "rev-2"],
    ]);
    expect(catalog.getStatus("default")).toMatchObject({ status: "partial" });
  });

  it("removes a deleted extension pack from the catalog without touching other partitions", async () => {
    const { raw } = createDb({ path: ":memory:" });
    const catalog = new PublicSkillCatalog(raw, await fixture(), config());
    const first = await fixture();
    await writeSkill(first, "core/grill-me", "grill-me", "core");
    await writeSkill(first, "extensions/aps/aps-scheduler", "aps-scheduler", "aps");
    publish(catalog, "default", "rev-1", await parsePublicSkillRepository(first, "shared-skills", "rev-1"));
    catalog.setTeamPolicy({ serviceId: "default", teamId: "team-1", packKeys: ["aps"], itemIds: [], updatedBy: "admin" });
    const second = await fixture();
    await writeSkill(second, "core/grill-me", "grill-me", "core v2");
    publish(catalog, "default", "rev-2", await parsePublicSkillRepository(second, "shared-skills", "rev-2"));

    expect(catalog.list("default", "", 100, 0).items.map((item) => item.name)).toEqual(["grill-me"]);
    expect((catalog.getStatus("default").partitions as Array<{ partition_key: string }>).map((item) => item.partition_key)).toEqual(["core"]);
    expect(catalog.getTeamPolicy("default", "team-1")).toMatchObject({ pack_keys: [], item_ids: [] });
  });

  it("uses core plus Team defaults for new Agents and keeps pack jobs idempotent", async () => {
    const { raw } = createDb({ path: ":memory:" });
    const dataDir = await fixture();
    const catalog = new PublicSkillCatalog(raw, dataDir, config());
    const root = await fixture();
    await writeSkill(root, "core/grill-me", "grill-me", "Clarify plans");
    await writeSkill(root, "extensions/aps/aps-scheduler", "aps-scheduler", "Plan a schedule");
    await writeSkill(root, "extensions/mes/mes-quality", "mes-quality", "Manage quality");
    publish(catalog, "default", "rev-1", await parsePublicSkillRepository(root, "shared-skills", "rev-1"));
    expect(catalog.effectiveItems("default", "team-without-policy").items.map((item) => item.name)).toEqual(["grill-me"]);
    const aps = catalog.list("default", "aps-", 10, 0).items[0];
    const mes = catalog.list("default", "mes-", 10, 0).items[0];
    const policy = catalog.setTeamPolicy({ serviceId: "default", teamId: "team-1", packKeys: ["mes"],
      itemIds: [aps.item_id, mes.item_id], updatedBy: "admin-1" });

    const first = catalog.createBootstrap({ serviceId: "default", teamId: "team-1", agentId: "agent-1", ownerUserId: "user-1" });
    const again = catalog.createBootstrap({ serviceId: "default", teamId: "team-1", agentId: "agent-1", ownerUserId: "user-1" });
    const pack = catalog.createPackInstall({ serviceId: "default", teamId: "team-1", agentId: "agent-1", ownerUserId: "user-1", packKey: "mes" });
    const packAgain = catalog.createPackInstall({ serviceId: "default", teamId: "team-1", agentId: "agent-1", ownerUserId: "user-1", packKey: "mes" });

    expect(first?.job_id).toBe(again?.job_id);
    expect(first).toMatchObject({ job_type: "agent_init", status: "pending", total: 3 });
    expect(pack?.job_id).toBe(packAgain?.job_id);
    expect(pack).toMatchObject({ job_type: "manual_pack", selection_key: "mes", total: 1 });
    expect(policy).toMatchObject({ pack_keys: ["mes"], item_ids: [aps.item_id] });
    expect(raw.prepare("SELECT DISTINCT source_revision FROM public_skill_bootstrap_item WHERE job_id=?")
      .all(first?.job_id)).toEqual([{ source_revision: "rev-1" }]);

    raw.prepare("UPDATE public_skill_bootstrap_item SET status='installed',attempts=2 WHERE job_id=?").run(pack?.job_id);
    raw.prepare("UPDATE public_skill_bootstrap_job SET status='completed',succeeded=total WHERE job_id=?").run(pack?.job_id);
    const reinstall = catalog.createPackInstall({ serviceId: "default", teamId: "team-1", agentId: "agent-1", ownerUserId: "user-1", packKey: "mes" });
    expect(reinstall).toMatchObject({ job_id: pack?.job_id, status: "pending", succeeded: 0 });
    expect((reinstall?.items as Array<{ status: string; attempts: number }>)).toEqual([
      expect.objectContaining({ status: "pending", attempts: 0 }),
    ]);
  });

  it("does not create installation work when automatic initialization is disabled", async () => {
    const { raw } = createDb({ path: ":memory:" });
    const catalog = new PublicSkillCatalog(raw, await fixture(), { ...config(), autoInstallOnAgentCreate: false });
    expect(catalog.createBootstrap({ serviceId: "default", teamId: "team-1", agentId: "agent-1", ownerUserId: "user-1" }))
      .toMatchObject({ job_id: null, job_type: "agent_init", status: "disabled", total: 0 });
    expect(raw.prepare("SELECT COUNT(*) count FROM public_skill_bootstrap_job").get()).toEqual({ count: 0 });
  });

  it("preserves a catalog item id when the same named Skill moves between extension packs", async () => {
    const { raw } = createDb({ path: ":memory:" });
    const catalog = new PublicSkillCatalog(raw, await fixture(), config());
    const first = await fixture();
    await writeSkill(first, "extensions/aps/aps-scheduler", "aps-scheduler", "v1");
    publish(catalog, "default", "rev-1", await parsePublicSkillRepository(first, "shared-skills", "rev-1"));
    const firstId = catalog.list("default", "aps-scheduler", 10, 0).items[0].item_id;

    const second = await fixture();
    await writeSkill(second, "extensions/planning/aps-scheduler", "aps-scheduler", "v2");
    publish(catalog, "default", "rev-2", await parsePublicSkillRepository(second, "shared-skills", "rev-2"));

    expect(catalog.list("default", "aps-scheduler", 10, 0).items[0]).toMatchObject({
      item_id: firstId, pack_key: "planning", source_revision: "rev-2",
    });
  });

  it("rejects unknown policy selections and recovers interrupted or failed jobs", async () => {
    const { raw } = createDb({ path: ":memory:" });
    const catalog = new PublicSkillCatalog(raw, await fixture(), config());
    const root = await fixture();
    await writeSkill(root, "core/grill-me", "grill-me", "core");
    await writeSkill(root, "extensions/aps/aps-scheduler", "aps-scheduler", "aps");
    publish(catalog, "default", "rev-1", await parsePublicSkillRepository(root, "shared-skills", "rev-1"));

    expect(() => catalog.setTeamPolicy({ serviceId: "default", teamId: "team-1", packKeys: ["missing"], itemIds: [], updatedBy: "admin" }))
      .toThrow("PUBLIC_SKILL_PACK_NOT_FOUND");
    expect(() => catalog.setTeamPolicy({ serviceId: "default", teamId: "team-1", packKeys: [], itemIds: ["missing"], updatedBy: "admin" }))
      .toThrow("PUBLIC_SKILL_ITEM_NOT_FOUND");
    expect(() => catalog.setTeamPolicy({ serviceId: "default", teamId: "team-1",
      packKeys: Array.from({ length: 1001 }, (_, index) => `pack-${index}`), itemIds: [], updatedBy: "admin" }))
      .toThrow("PUBLIC_SKILL_POLICY_TOO_LARGE");

    const job = catalog.createBootstrap({ serviceId: "default", teamId: "team-1", agentId: "agent-1", ownerUserId: "user-1" });
    raw.prepare("UPDATE public_skill_bootstrap_job SET status='running' WHERE job_id=?").run(job?.job_id);
    raw.prepare("UPDATE public_skill_bootstrap_item SET status='installing' WHERE job_id=?").run(job?.job_id);
    (catalog as unknown as { recoverInterruptedBootstrap(): void }).recoverInterruptedBootstrap();
    expect(catalog.bootstrapStatus(String(job?.job_id))).toMatchObject({ status: "pending" });
    expect((catalog.bootstrapStatus(String(job?.job_id))?.items as Array<{ status: string }>).every((item) => item.status === "pending")).toBe(true);

    const firstItem = (catalog.bootstrapStatus(String(job?.job_id))?.items as Array<{ item_id: string }>)[0];
    raw.prepare("UPDATE public_skill_bootstrap_item SET attempts=3,status='installing' WHERE job_id=? AND item_id=?")
      .run(job?.job_id, firstItem.item_id);
    catalog.completeBootstrap({ jobId: String(job?.job_id), itemId: firstItem.item_id, error: "simulated failure" });
    expect((catalog.bootstrapStatus(String(job?.job_id))?.items as Array<{ item_id: string; status: string }>).find((item) => item.item_id === firstItem.item_id)?.status).toBe("failed");
    catalog.retryBootstrap(String(job?.job_id));
    expect((catalog.bootstrapStatus(String(job?.job_id))?.items as Array<{ item_id: string; status: string }>).find((item) => item.item_id === firstItem.item_id)?.status).toBe("pending");
    catalog.cancelAgent("default", "agent-1");
    expect(catalog.bootstrapStatus(String(job?.job_id))).toMatchObject({ status: "cancelled" });
  });

  it("records a bounded retry when a pinned snapshot is unavailable", async () => {
    const { raw } = createDb({ path: ":memory:" });
    const catalog = new PublicSkillCatalog(raw, await fixture(), config());
    const root = await fixture();
    await writeSkill(root, "extensions/aps/aps-scheduler", "aps-scheduler", "aps");
    publish(catalog, "default", "rev-missing", await parsePublicSkillRepository(root, "shared-skills", "rev-missing"));
    const job = catalog.createPackInstall({ serviceId: "default", teamId: "team-1", agentId: "agent-1", ownerUserId: "user-1", packKey: "aps" });

    await expect(catalog.claimBootstrap()).resolves.toBeNull();
    expect(catalog.bootstrapStatus(String(job?.job_id))).toMatchObject({ status: "running" });
    expect(job && (catalog.bootstrapStatus(job.job_id)?.items as Array<{ status: string; attempts: number; last_error: string }>)[0])
      .toMatchObject({ status: "pending", attempts: 1, last_error: expect.stringContaining("snapshot unavailable") });
  });

  it("migrates legacy one-job-per-Agent bootstrap data to typed install jobs", async () => {
    const root = await fixture();
    const path = join(root, "legacy.sqlite");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE public_skill_bootstrap_job (
        job_id TEXT PRIMARY KEY, service_id TEXT NOT NULL, source_id TEXT NOT NULL, team_id TEXT NOT NULL,
        agent_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, source_revision TEXT, status TEXT NOT NULL,
        total INTEGER NOT NULL, succeeded INTEGER NOT NULL, failed INTEGER NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, UNIQUE(service_id,source_id,agent_id));
      CREATE TABLE public_skill_bootstrap_item (
        job_id TEXT NOT NULL, item_id TEXT NOT NULL, repo_path TEXT NOT NULL, name TEXT NOT NULL,
        description TEXT NOT NULL, content_hash TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL,
        installed_skill_id TEXT, last_error TEXT, next_attempt_at INTEGER NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(job_id,item_id));
      CREATE INDEX idx_public_skill_bootstrap_due ON public_skill_bootstrap_item(status,next_attempt_at);
      INSERT INTO public_skill_bootstrap_job VALUES
        ('job-1','default','shared-skills','team-1','agent-1','user-1','rev-old','completed',1,1,0,'now','now');
      INSERT INTO public_skill_bootstrap_item VALUES
        ('job-1','pub-1','skills/grill-me','grill-me','Clarify','hash','installed',1,'skl-1',NULL,0,'now');
    `);
    legacy.close();

    const { raw } = createDb({ path });
    expect(raw.prepare("SELECT job_type,idempotency_key FROM public_skill_bootstrap_job WHERE job_id='job-1'").get())
      .toEqual({ job_type: "agent_init", idempotency_key: "agent-init:agent-1" });
    expect(raw.prepare("SELECT source_revision FROM public_skill_bootstrap_item WHERE job_id='job-1'").get())
      .toEqual({ source_revision: "rev-old" });
    expect((raw.pragma("index_list(public_skill_bootstrap_job)") as Array<{ unique: number }>).some((index) => index.unique === 1)).toBe(true);
    raw.close();
  });
});

function publish(catalog: PublicSkillCatalog, serviceId: string, revision: string, parsed: Awaited<ReturnType<typeof parsePublicSkillRepository>>) {
  (catalog as unknown as { publishParsedRepository(s: string, r: string, p: typeof parsed): void })
    .publishParsedRepository(serviceId, revision, parsed);
}

function config() {
  return { enabled: true, sourceId: "shared-skills", sourceName: "Public", repoUrl: "http://git/repo.git",
    branch: "main", syncIntervalMs: 300000, defaultServiceId: "default", autoInstallOnAgentCreate: true };
}

async function writeSkill(root: string, path: string, name: string, description: string, resources: Record<string, string> = {}) {
  const skill = join(root, ...path.split("/"));
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
  for (const [resourcePath, content] of Object.entries(resources)) {
    const target = join(skill, ...resourcePath.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content, { mode: resourcePath.endsWith(".sh") ? 0o755 : 0o644 });
  }
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "public-skills-"));
  dirs.push(root);
  await mkdir(join(root, "core"), { recursive: true });
  await mkdir(join(root, "extensions"), { recursive: true });
  return root;
}
