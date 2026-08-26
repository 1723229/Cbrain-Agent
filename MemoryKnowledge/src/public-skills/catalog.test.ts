import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import { parsePublicSkills, PublicSkillCatalog } from "./catalog.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("PublicSkillCatalog", () => {
  it("parses a repository skill and preserves supporting resources", async () => {
    const root = await fixture();
    const skill = join(root, "skills", "database-review");
    await mkdir(join(skill, "scripts"), { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\nname: database-review\ndescription: Review database changes\n---\n\n# Review\n");
    await writeFile(join(skill, "scripts", "check.sh"), "echo ok\n", { mode: 0o755 });

    const items = await parsePublicSkills(root, "shared-skills", "abc123");

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "database-review", source_revision: "abc123" });
    expect(items[0].manifest).toEqual([expect.objectContaining({ path: "scripts/check.sh" })]);
  });

  it("rejects a skill directory whose name differs from frontmatter", async () => {
    const root = await fixture();
    const skill = join(root, "skills", "wrong-name");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\nname: actual-name\ndescription: x\n---\n");
    await expect(parsePublicSkills(root, "shared-skills", "abc")).rejects.toThrow(/directory name/);
  });

  it.skipIf(process.platform === "win32")("rejects symlink resources", async () => {
    const root = await fixture();
    const skill = join(root, "skills", "unsafe");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\nname: unsafe\ndescription: x\n---\n");
    await symlink(join(skill, "SKILL.md"), join(skill, "linked.md"));
    await expect(parsePublicSkills(root, "shared-skills", "abc")).rejects.toThrow(/symlink/);
  });

  it.skipIf(process.platform === "win32")("creates an idempotent bootstrap job pinned to the active catalog", async () => {
    const { raw } = createDb({ path: ":memory:" });
    const dataDir = await fixture();
    const config = { enabled: true, sourceId: "shared-skills", sourceName: "Public", repoUrl: "http://git/repo.git", branch: "main", syncIntervalMs: 300000, defaultServiceId: "default", autoInstallOnAgentCreate: true };
    const catalog = new PublicSkillCatalog(raw, dataDir, config);
    const now = new Date().toISOString();
    raw.prepare(`INSERT INTO public_skill_catalog_source
      (service_id,source_id,source_name,repo_url,branch,active_commit,status,last_sync_at,last_success_at,updated_at)
      VALUES ('default','shared-skills','Public','http://git/repo.git','main','abc','ready',?,?,?)`).run(now, now, now);
    raw.prepare(`INSERT INTO public_skill_catalog_item
      (service_id,source_id,item_id,repo_path,name,description,source_revision,content_hash,manifest_json,total_bytes,created_at,updated_at)
      VALUES ('default','shared-skills','pub-1','skills/one','one','One','abc','hash','[]',0,?,?)`).run(now, now);

    const first = catalog.createBootstrap({ serviceId: "default", teamId: "team-1", agentId: "agent-1", ownerUserId: "user-1" });
    const again = catalog.createBootstrap({ serviceId: "default", teamId: "team-1", agentId: "agent-1", ownerUserId: "user-1" });

    expect(first?.job_id).toBe(again?.job_id);
    expect(first).toMatchObject({ source_revision: "abc", status: "pending", total: 1 });
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "public-skills-"));
  dirs.push(root);
  return root;
}
