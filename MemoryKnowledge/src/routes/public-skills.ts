import { Hono } from "hono";
import type { Context } from "hono";
import { wrapError, wrapOk } from "../api-helpers.js";
import { CatalogError, type PublicSkillCatalog } from "../public-skills/catalog.js";

export function createPublicSkillRoutes(catalog: PublicSkillCatalog) {
  const app = new Hono();
  const serviceId = (c: { req: { header(name: string): string | undefined } }) => c.req.header("x-tdai-service-id")?.trim() || "";
  const body = async (c: { req: { json(): Promise<unknown> } }) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  app.use("*", async (c, next) => {
    const expected = process.env.KNOWLEDGE_AUTH_TOKEN?.trim();
    if (!expected) return c.json(wrapError(503, "PUBLIC_SKILL_CONTROL_TOKEN_NOT_CONFIGURED"), 503);
    if (c.req.header("authorization") !== `Bearer ${expected}`) return c.json(wrapError(401, "UNAUTHORIZED"), 401);
    await next();
  });

  app.post("/status", (c) => {
    const sid = serviceId(c);
    if (!sid) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    return c.json(wrapOk(catalog.getStatus(sid)));
  });
  app.post("/list", async (c) => {
    const sid = serviceId(c); const b = await body(c);
    if (!sid) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    return c.json(wrapOk(catalog.list(sid, str(b.query), num(b.limit, 100), num(b.offset, 0))));
  });
  app.post("/get", async (c) => {
    const sid = serviceId(c); const b = await body(c); const item = catalog.get(sid, str(b.item_id));
    return item ? c.json(wrapOk(item)) : c.json(wrapError(404, "PUBLIC_SKILL_NOT_FOUND"), 404);
  });
  app.post("/snapshot", async (c) => {
    try { const sid = serviceId(c); const b = await body(c); return c.json(wrapOk(await catalog.snapshot(sid, str(b.item_id), str(b.expected_revision) || undefined))); }
    catch (error) { return catalogError(c, error); }
  });
  app.post("/sync", async (c) => {
    const sid = serviceId(c);
    if (!sid) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    return c.json(wrapOk(await catalog.sync(sid)));
  });
  app.post("/bootstrap/create", async (c) => {
    const sid = serviceId(c); const b = await body(c);
    await Promise.race([catalog.ensureFresh(sid), new Promise((resolve) => setTimeout(resolve, 5000))]);
    return c.json(wrapOk(catalog.createBootstrap({ serviceId: sid, teamId: str(b.team_id), agentId: str(b.agent_id), ownerUserId: str(b.owner_user_id) })));
  });
  app.post("/bootstrap/status", async (c) => {
    const sid = serviceId(c); const b = await body(c);
    const result = str(b.job_id) ? catalog.bootstrapStatus(str(b.job_id)) : catalog.bootstrapForAgent(sid, str(b.agent_id));
    return result ? c.json(wrapOk(result)) : c.json(wrapError(404, "BOOTSTRAP_JOB_NOT_FOUND"), 404);
  });
  app.post("/bootstrap/retry", async (c) => {
    const b = await body(c); const result = catalog.retryBootstrap(str(b.job_id));
    return result ? c.json(wrapOk(result)) : c.json(wrapError(404, "BOOTSTRAP_JOB_NOT_FOUND"), 404);
  });
  app.post("/bootstrap/claim", async (c) => c.json(wrapOk(await catalog.claimBootstrap())));
  app.post("/bootstrap/complete", async (c) => {
    const b = await body(c); const result = catalog.completeBootstrap({ jobId: str(b.job_id), itemId: str(b.item_id), skillId: str(b.skill_id) || undefined, error: str(b.error) || undefined });
    return result ? c.json(wrapOk(result)) : c.json(wrapError(404, "BOOTSTRAP_ITEM_NOT_FOUND"), 404);
  });
  app.post("/bootstrap/cancel", async (c) => { const sid = serviceId(c); const b = await body(c); catalog.cancelAgent(sid, str(b.agent_id)); return c.json(wrapOk({ cancelled: true })); });
  return app;
}

function str(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function num(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function catalogError(c: Context, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof CatalogError && message === "CATALOG_REVISION_CHANGED" ? 409 : 404;
  return c.json(wrapError(status, message), status);
}
