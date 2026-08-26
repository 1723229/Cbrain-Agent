import { describe, expect, it, vi } from "vitest";
import { handleSnapshotApply, type SkillRouterDeps } from "./skill-handlers.js";
import type { Skill } from "../core/skill/types.js";

const result: Skill = {
  row_id: "row-1", skill_id: "skl-1", version: 1, is_head: true,
  user_id: "user-1", owner_agent_id: "agent-1", team_id: "team-1", task_id: "",
  name: "public-one", description: "Public", content: "---\nname: public-one\ndescription: Public\n---\n",
  content_hash: "hash", manifest: [], storage_dir: "skills/skl-1/v1", status: "active",
  metadata_json: "{}", created_at_ms: 1, updated_at_ms: 1,
};

describe("skill snapshot apply handler", () => {
  it("applies one complete snapshot and ensures the skill asset", async () => {
    const applySnapshot = vi.fn(async () => result);
    const ensureSkillAsset = vi.fn(async () => ({}));
    const deps = {
      getSkillCore: () => ({ applySnapshot }),
      getMetadataService: async () => ({ ensureSkillAsset }),
      logger: { info() {}, warn() {}, error() {} },
    } as unknown as SkillRouterDeps;

    const envelope = await handleSnapshotApply({
      user_id: "user-1", team_id: "team-1", agent_id: "agent-1",
      name: "public-one", content: result.content, resources: [],
      metadata: { catalog_origin: { source_id: "shared-skills", item_id: "pub-1" } },
    }, { apiKey: "service", serviceId: "default" }, "request-1", deps);

    expect(envelope.code).toBe(0);
    expect(applySnapshot).toHaveBeenCalledOnce();
    expect(ensureSkillAsset).toHaveBeenCalledWith({ skill_id: "skl-1", team_id: "team-1", agent_id: "agent-1", name: "public-one" });
  });

  it("rejects a partial update identity before calling core", async () => {
    const applySnapshot = vi.fn();
    const deps = { getSkillCore: () => ({ applySnapshot }), logger: { info() {}, warn() {}, error() {} } } as unknown as SkillRouterDeps;
    const envelope = await handleSnapshotApply({ user_id: "u", team_id: "t", agent_id: "a", skill_id: "skl-1",
      name: "one", content: "x", resources: [], metadata: {} }, { apiKey: "service", serviceId: "default" }, "r", deps);
    expect(envelope.code).toBe(40001);
    expect(applySnapshot).not.toHaveBeenCalled();
  });
});
