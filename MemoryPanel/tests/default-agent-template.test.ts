import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  deleteAgentTemplate,
  getAgentTemplate,
  parseAgentTemplate,
  saveAgentTemplate,
} from "../src/panel/state/agent-template-store.js";
import {
  ensureDefaultAgentForUser,
  filterTemplateSkillsByPublicNames,
} from "../src/panel/services/default-agent-orchestrator.js";
import type { PanelDeps } from "../src/panel/panel-deps.js";
import { buildPanelApp } from "../src/panel/http/app.js";
import { InstanceRegistry } from "../src/panel/config/instance-registry.js";

describe("default Agent templates", () => {
  it("writes atomically, overwrites, and deletes from the configured persistent root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cbrain-agent-template-"));
    saveAgentTemplate(root, "default", "team-one", {
      name: "研发助手",
      asset_ids: { skills: ["skl-1"] },
    });
    expect(getAgentTemplate(root, "default", "team-one")).toMatchObject({
      name: "研发助手",
    });

    saveAgentTemplate(root, "default", "team-one", { name: "评审助手" });
    expect(getAgentTemplate(root, "default", "team-one")).toEqual({
      name: "评审助手",
    });
    expect(readdirSync(path.join(root, "default", "team-one"))).toEqual([
      "template.json",
    ]);

    deleteAgentTemplate(root, "default", "team-one");
    expect(getAgentTemplate(root, "default", "team-one")).toBeNull();
  });

  it("rejects instance and team identifiers that can escape the storage root", () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "cbrain-agent-template-path-"),
    );
    expect(() =>
      saveAgentTemplate(root, "../outside", "team-one", { name: "x" }),
    ).toThrow(/invalid instance/i);
    expect(() =>
      saveAgentTemplate(root, "default", "../outside", { name: "x" }),
    ).toThrow(/invalid team/i);
  });

  it("validates and normalizes template input before persistence", () => {
    expect(
      parseAgentTemplate({
        name: " 研发助手 ",
        asset_ids: { skills: ["skl-1", "skl-1"] },
      }),
    ).toMatchObject({ name: "研发助手", asset_ids: { skills: ["skl-1"] } });
    expect(parseAgentTemplate({ name: "" })).toBeNull();
    expect(
      parseAgentTemplate({ name: "x", asset_ids: { skills: [123] } }),
    ).toBeNull();
  });

  it("authorizes template writes from the HttpOnly Web Session user type", async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "cbrain-agent-template-route-"),
    );
    const deps = {
      config: {
        agentTemplateDir: root,
        ui: { distDir: "" },
        pluginDownloads: { dir: "" },
        session: { cookieName: "cbrain_session" },
      },
      instanceRegistry: new InstanceRegistry([
        {
          instance_id: "default",
          name: "Default",
          gateway_endpoint: "http://core",
          api_key: "service",
        },
      ]),
      authService: {
        resolveSession: async () => ({
          user_id: "usr-admin",
          username: "admin",
          user_type: "system_admin",
          status: "active",
        }),
      },
      knowledgeClientFactory: () => ({
        publicSkillList: async () => ({ items: [], total: 0 }),
      }),
      skillKernel: { invoke: vi.fn() },
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        child() {
          return this;
        },
      },
    } as unknown as PanelDeps;

    const response = await buildPanelApp(deps).request(
      "/api/v1/meta/agent/set-default-template",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tdai-service-id": "default",
          cookie: "cbrain_session=session-token",
        },
        body: JSON.stringify({
          team_id: "team-one",
          template: { name: "研发助手" },
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(getAgentTemplate(root, "default", "team-one")).toMatchObject({
      name: "研发助手",
    });
  });

  it("gives public Skills precedence over same-name template Skills", () => {
    expect(
      filterTemplateSkillsByPublicNames(
        [
          { skillId: "skl-code-review", name: "code-review" },
          { skillId: "skl-team-only", name: "team-only" },
        ],
        new Set(["code-review", "grill-me"]),
      ),
    ).toEqual({
      keptSkillIds: ["skl-team-only"],
      skippedSkillIds: ["skl-code-review"],
    });
  });

  it("creates one default Agent, skips colliding template Skills, and enqueues public Skills", async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "cbrain-agent-template-flow-"),
    );
    saveAgentTemplate(root, "default", "team-one", {
      name: "研发助手",
      asset_ids: { skills: ["skl-code-review", "skl-team-only"] },
    });
    const skillCreate = vi.fn(async () => ({
      code: 0,
      message: "ok",
      data: { skill_id: "skl-copy" },
    }));
    const bootstrap = vi.fn(async () => ({ job_id: "job-1" }));
    const deps = {
      config: { agentTemplateDir: root },
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        child() {
          return this;
        },
      },
      knowledgeClientFactory: () => ({
        publicSkillList: async () => ({
          items: [{ name: "code-review" }],
          total: 1,
        }),
        publicSkillBootstrapCreate: bootstrap,
      }),
      metaKernel: {
        invoke: vi.fn(async (action: string) => {
          if (action === "user/get")
            return { code: 0, message: "ok", data: { username: "alice" } };
          if (action === "agent/list")
            return { code: 0, message: "ok", data: { items: [], total: 0 } };
          if (action === "agent/create")
            return { code: 0, message: "ok", data: { agent_id: "agt-new" } };
          throw new Error(`unexpected meta action: ${action}`);
        }),
      },
      skillKernel: {
        invoke: vi.fn(async (action: string, body: Record<string, unknown>) => {
          if (action === "get") {
            const skillId = String(body.skill_id);
            return {
              code: 0,
              message: "ok",
              data: {
                name:
                  skillId === "skl-code-review" ? "code-review" : "team-only",
                content: "---\nname: team-only\ndescription: Team only\n---\n",
                manifest: [],
              },
            };
          }
          if (action === "create") return skillCreate();
          throw new Error(`unexpected skill action: ${action}`);
        }),
      },
    } as unknown as PanelDeps;

    await ensureDefaultAgentForUser(
      { userId: "usr-alice", teamId: "team-one" },
      {
        instanceId: "default",
        gatewayEndpoint: "http://core",
        gatewayApiKey: "service",
        userId: "usr-admin",
      },
      deps,
    );

    expect(skillCreate).toHaveBeenCalledOnce();
    expect(deps.skillKernel.invoke).toHaveBeenCalledWith(
      "create",
      expect.objectContaining({
        name: "team-only",
        agent_id: "agt-new",
      }),
      expect.anything(),
    );
    expect(bootstrap).toHaveBeenCalledWith({
      team_id: "team-one",
      agent_id: "agt-new",
      owner_user_id: "usr-alice",
    });
  });
});
