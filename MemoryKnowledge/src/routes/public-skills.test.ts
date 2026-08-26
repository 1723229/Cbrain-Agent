import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicSkillRoutes } from "./public-skills.js";
import type { PublicSkillCatalog } from "../public-skills/catalog.js";

afterEach(() => vi.unstubAllEnvs());

describe("public Skill routes", () => {
  it("requires the Panel-to-Knowledge control token", async () => {
    vi.stubEnv("KNOWLEDGE_AUTH_TOKEN", "control-secret");
    const app = createPublicSkillRoutes({ getStatus: () => ({ status: "ready" }) } as unknown as PublicSkillCatalog);
    const unauthorized = await app.request("/status", { method: "POST", headers: { "x-tdai-service-id": "default" } });
    expect(unauthorized.status).toBe(401);
    const authorized = await app.request("/status", { method: "POST", headers: {
      "x-tdai-service-id": "default", authorization: "Bearer control-secret",
    } });
    expect(authorized.status).toBe(200);
    expect((await authorized.json()).data).toMatchObject({ status: "ready" });
  });
});
