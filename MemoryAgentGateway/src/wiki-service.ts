import type { CoreDirectoryClient } from "./core-client.js";
import type { KnowledgeClient } from "./knowledge-client.js";
import type { GatewayPrincipal, KnowledgeResource } from "./types.js";

export interface WikiBinding { team_id: string; agent_id: string; agent_name: string }
export interface ScopedWikiResource extends KnowledgeResource { bindings: WikiBinding[] }
export interface OwnedAgentRecord { agent_id: string; team_id: string; owner_user_id: string; name: string; status: string }
export type LoadAgentKnowledge = (agent: OwnedAgentRecord, principal: GatewayPrincipal) => Promise<KnowledgeResource[]>;

export class WikiScopeResolver {
  private readonly cache = new Map<string, { expiresAt: number; value: Promise<ScopedWikiResource[]> }>();
  constructor(private readonly directory: Pick<CoreDirectoryClient, "listOwnedActiveAgents">, private readonly loadAgentKnowledge: LoadAgentKnowledge, private readonly ttlMs = 30_000) {}

  resolve(principal: GatewayPrincipal): Promise<ScopedWikiResource[]> {
    const now = Date.now();
    const cached = this.cache.get(principal.id);
    if (this.ttlMs > 0 && cached && cached.expiresAt > now) return cached.value;
    const value = this.load(principal);
    if (this.ttlMs > 0) {
      this.cache.set(principal.id, { expiresAt: now + this.ttlMs, value });
      value.catch(() => this.cache.delete(principal.id));
    }
    return value;
  }

  private async load(principal: GatewayPrincipal): Promise<ScopedWikiResource[]> {
    const agents = await this.directory.listOwnedActiveAgents(principal);
    const pages = await mapLimit(agents, 4, async (agent) => ({ agent, resources: await this.loadAgentKnowledge(agent, principal) }));
    const byId = new Map<string, ScopedWikiResource>();
    for (const { agent, resources } of pages) {
      for (const resource of resources) {
        if (resource.type !== "wiki" || resource.status !== "ready") continue;
        const binding = { team_id: agent.team_id, agent_id: agent.agent_id, agent_name: agent.name };
        const current = byId.get(resource.knowledge_id);
        if (current) { if(!current.bindings.some((item)=>item.team_id===binding.team_id&&item.agent_id===binding.agent_id))current.bindings.push(binding); }
        else byId.set(resource.knowledge_id, { ...resource, bindings: [binding] });
      }
    }
    return [...byId.values()].sort((a, b) => a.knowledge_id.localeCompare(b.knowledge_id));
  }
}

export class WikiAccessService {
  constructor(private readonly resolveResources: () => Promise<KnowledgeResource[]>, private readonly knowledge: Pick<KnowledgeClient, "callTool">) {}

  async resources(): Promise<KnowledgeResource[]> { return (await this.resolveResources()).filter((item) => item.type === "wiki" && item.status === "ready"); }

  async search(query: string, wikiIds?: string[], limit = 10): Promise<{ results: Array<Record<string, unknown>>; warnings: Array<{ wiki_id: string; error: string }> }> {
    const selected = await this.select(wikiIds);
    if (!selected.length) return { results: [], warnings: [] };
    const outcomes = await mapLimit(selected, 4, async (resource) => {
      try {
        const raw = await this.knowledge.callTool(resource.knowledge_id, "search", { query: required(query, "query"), limit: 20 }) as { results?: Array<Record<string, unknown>> };
        return { resource, results: raw.results ?? [] };
      } catch (error) { return { resource, error: message(error), results: [] }; }
    });
    const warnings = outcomes.flatMap((item) => item.error ? [{ wiki_id: item.resource.knowledge_id, error: item.error }] : []);
    if (warnings.length === outcomes.length) throw new Error(`all Wiki searches failed: ${warnings.map((item) => `${item.wiki_id}: ${item.error}`).join("; ")}`);
    const ranked = outcomes.flatMap(({ resource, results }) => results.map((item, rank) => ({
      ...item,
      wiki_id: resource.knowledge_id,
      wiki_name: resource.name,
      bindings: resource.bindings ?? [],
      page_ref: encodeRef("page", resource.knowledge_id, pagePath(item)),
      rrf_score: 1 / (60 + rank + 1),
    }))).sort((a, b) => Number(b.rrf_score) - Number(a.rrf_score)).slice(0, bounded(limit, 1, 20, 10));
    return { results: ranked, warnings };
  }

  async list(wikiId: string, cursor?: string, limit = 50): Promise<{ wiki_id: string; wiki_name: string; bindings: unknown; items: Array<Record<string, unknown> & { page_ref: string }>; next_cursor: string | null }> {
    const resource = await this.requireResource(wikiId);
    const raw = await this.knowledge.callTool(wikiId, "list_pages", {}) as { items?: Array<Record<string, unknown>> };
    const offset = decodeCursor(cursor);
    const pageSize = bounded(limit, 1, 100, 50);
    const all = raw.items ?? [];
    const items = all.slice(offset, offset + pageSize).map((item) => ({ ...item, page_ref: encodeRef("page", wikiId, pagePath(item)) }));
    const next = offset + items.length < all.length ? encodeCursor(offset + items.length) : null;
    return { wiki_id: resource.knowledge_id, wiki_name: resource.name, bindings: resource.bindings ?? [], items, next_cursor: next };
  }

  async read(pageRefs: string[], maxChars = 50_000): Promise<{ items: Array<Record<string, unknown> & { page_ref: string; source_refs: string[] }> }> {
    const groups = groupRefs(pageRefs, "page");
    const batches=await mapLimit([...groups],4,async([wikiId,refs])=>{
      const resource=await this.requireResource(wikiId);
      const raw = await this.knowledge.callTool(wikiId, "read_page", { refs: refs.map((item) => item.value) }) as { items?: Array<Record<string, unknown>> };
      return (raw.items??[]).map((item,index)=>{
        const ref = stringValue(item.ref) || refs[index]?.value || "";
        const content = stringValue(item.content);
        return { ...item, wiki_id:wikiId, wiki_name:resource.name, bindings:resource.bindings??[], content: truncate(content, maxChars), page_ref: encodeRef("page", wikiId, ref), source_refs: parseSources(content).map((source) => encodeRef("source", wikiId, source)) };
      });
    });
    return { items:batches.flat() };
  }

  async readSources(sourceRefs: string[], maxChars = 50_000): Promise<{ items: Array<Record<string, unknown>> }> {
    const groups = groupRefs(sourceRefs, "source");
    const batches=await mapLimit([...groups],4,async([wikiId,refs])=>{
      const resource=await this.requireResource(wikiId);
      const raw = await this.knowledge.callTool(wikiId, "read_raw", { filenames: refs.map((item) => item.value) }) as { items?: Array<Record<string, unknown>> };
      return (raw.items??[]).map((item,index)=>({ ...item, wiki_id:wikiId, wiki_name:resource.name, bindings:resource.bindings??[], content: truncate(stringValue(item.content), maxChars), source_ref: encodeRef("source", wikiId, stringValue(item.filename) || stringValue(item.ref) || refs[index]!.value) }));
    });
    return { items:batches.flat() };
  }

  async related(pageRef: string, depth = 1, limit = 10): Promise<{ wiki_id: string; wiki_name: string; bindings: unknown; items: Array<Record<string, unknown>> }> {
    const decoded = decodeRef(pageRef, "page");
    const resource=await this.requireResource(decoded.wikiId);
    const raw=await this.knowledge.callTool(decoded.wikiId,"related_pages",{ref:decoded.value,depth:bounded(depth,1,2,1),limit:bounded(limit,1,20,10)}) as {items?:Array<Record<string,unknown>>};
    const items=(raw.items??[]).map((item)=>({...item,page_ref:encodeRef("page",decoded.wikiId,pagePath(item))}));
    return { wiki_id: decoded.wikiId, wiki_name:resource.name, bindings:resource.bindings??[], items };
  }

  private async select(wikiIds?: string[]): Promise<KnowledgeResource[]> {
    const resources = await this.resources();
    if (!wikiIds?.length) return resources;
    const requested = new Set(wikiIds);
    const selected = resources.filter((item) => requested.has(item.knowledge_id));
    const missing = [...requested].filter((id) => !selected.some((item) => item.knowledge_id === id));
    if (missing.length) throw new Error(`Wiki is not accessible in the active scope: ${missing.join(", ")}`);
    return selected;
  }
  private async requireResource(wikiId: string): Promise<KnowledgeResource> {
    const resource = (await this.resources()).find((item) => item.knowledge_id === wikiId);
    if (!resource) throw new Error(`Wiki is not accessible in the active scope: ${wikiId}`);
    return resource;
  }
}

interface DecodedRef { wikiId: string; value: string }
function encodeRef(kind: "page" | "source", wikiId: string, value: string): string { return `cbrain-${kind}:${Buffer.from(JSON.stringify({ v: 1, wiki_id: wikiId, value }), "utf8").toString("base64url")}`; }
function decodeRef(ref: string, kind: "page" | "source"): DecodedRef {
  try {
    const prefix = `cbrain-${kind}:`;
    if (!ref.startsWith(prefix)) throw new Error();
    const value = JSON.parse(Buffer.from(ref.slice(prefix.length), "base64url").toString("utf8")) as { v?: unknown; wiki_id?: unknown; value?: unknown };
    if (value.v !== 1 || typeof value.wiki_id !== "string" || !value.wiki_id || typeof value.value !== "string" || !value.value) throw new Error();
    return { wikiId: value.wiki_id, value: value.value };
  } catch { throw new Error(`invalid ${kind}_ref`); }
}
function groupRefs(refs: string[], kind: "page" | "source"): Map<string, DecodedRef[]> {
  if (!Array.isArray(refs) || !refs.length || refs.length > 20) throw new Error(`${kind}_refs must contain between 1 and 20 items`);
  const groups = new Map<string, DecodedRef[]>();
  for (const ref of refs) { const decoded = decodeRef(ref, kind); groups.set(decoded.wikiId, [...(groups.get(decoded.wikiId) ?? []), decoded]); }
  return groups;
}
function pagePath(item: Record<string, unknown>): string { const value = stringValue(item.path) || stringValue(item.id) || stringValue(item.ref); if (!value) throw new Error("Wiki page is missing a stable path"); return value; }
function parseSources(content: string): string[] {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  const inline = frontmatter.match(/^sources:\s*\[([^\]]*)\]\s*$/m)?.[1];
  if (inline !== undefined) return inline.split(",").map(cleanYaml).filter(Boolean);
  const block = frontmatter.match(/^sources:\s*\r?\n((?:\s+-\s+.*(?:\r?\n|$))*)/m)?.[1] ?? "";
  return block.split(/\r?\n/).map((line) => cleanYaml(line.replace(/^\s*-\s+/, ""))).filter(Boolean);
}
function cleanYaml(value: string): string { return value.trim().replace(/^['"]|['"]$/g, ""); }
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function required(value: string, name: string): string { const normalized = value.trim(); if (!normalized) throw new Error(`${name} is required`); return normalized.slice(0, 2048); }
function bounded(value: number, min: number, max: number, fallback: number): number { return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback; }
function truncate(value: string, maxChars: number): string { const max = bounded(maxChars, 256, 100_000, 50_000); return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated]`; }
function encodeCursor(offset: number): string { return `cbrain-cursor:${Buffer.from(String(offset)).toString("base64url")}`; }
function decodeCursor(cursor?: string): number { if (!cursor) return 0; try { const value = Number(Buffer.from(cursor.replace(/^cbrain-cursor:/, ""), "base64url").toString()); if (!cursor.startsWith("cbrain-cursor:") || !Number.isSafeInteger(value) || value < 0) throw new Error(); return value; } catch { throw new Error("invalid cursor"); } }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
async function mapLimit<T, R>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { while (true) { const index = next++; if (index >= items.length) return; results[index] = await worker(items[index]!); } }));
  return results;
}
