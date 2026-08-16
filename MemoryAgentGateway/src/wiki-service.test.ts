import { describe, expect, it, vi } from "vitest";

import { WikiAccessService, WikiScopeResolver } from "./wiki-service.js";
import type { GatewayPrincipal, KnowledgeResource } from "./types.js";

const principal: GatewayPrincipal = { id: "user:u1", userId: "u1", userKey: "key" };
const wiki = (id: string, name = id): KnowledgeResource => ({ knowledge_id: id, type: "wiki", name, status: "ready" });

describe("WikiScopeResolver", () => {
  it("unions active user-owned agents across teams and deduplicates Wiki bindings", async () => {
    const directory = { listOwnedActiveAgents: vi.fn(async () => [
      { agent_id: "a1", team_id: "t1", owner_user_id: "u1", name: "A1", status: "active" },
      { agent_id: "a2", team_id: "t2", owner_user_id: "u1", name: "A2", status: "active" },
    ]) };
    const load = vi.fn(async (agent: { agent_id: string }) => agent.agent_id === "a1" ? [wiki("wiki-1", "Shared"), wiki("wiki-2")] : [wiki("wiki-1", "Shared")]);
    const resolver = new WikiScopeResolver(directory as never, load, 0);

    const resources = await resolver.resolve(principal);

    expect(resources.map((item) => item.knowledge_id)).toEqual(["wiki-1", "wiki-2"]);
    expect(resources[0]?.bindings).toEqual([
      { team_id: "t1", agent_id: "a1", agent_name: "A1" },
      { team_id: "t2", agent_id: "a2", agent_name: "A2" },
    ]);
  });
});

describe("WikiAccessService", () => {
  it("searches all scoped Wikis, merges them with RRF, and reports partial failures", async () => {
    const knowledge = { callTool: vi.fn(async (id: string, tool: string) => {
      if (id === "wiki-b") throw new Error("upstream timeout");
      expect(tool).toBe("search");
      return { results: [{ path: "wiki/design.md", title: "Design", snippet: "existing design", score: 9 }] };
    }) };
    const service = new WikiAccessService(async () => [wiki("wiki-a", "A"), wiki("wiki-b", "B")], knowledge as never);

    const result = await service.search("existing方案", undefined, 10);

    expect(result.results).toMatchObject([{ wiki_id: "wiki-a", title: "Design" }]);
    expect(result.results[0]?.page_ref).toMatch(/^cbrain-page:/);
    expect(result.warnings).toEqual([{ wiki_id: "wiki-b", error: "upstream timeout" }]);
  });

  it("fails explicitly when every scoped Wiki search fails",async()=>{const knowledge={callTool:vi.fn(async()=>{throw new Error("offline")})};const service=new WikiAccessService(async()=>[wiki("wiki-a"),wiki("wiki-b")],knowledge as never);await expect(service.search("query")).rejects.toThrow("all Wiki searches failed")});

  it("authorizes opaque page/source refs and exposes source refs from page frontmatter", async () => {
    const knowledge = { callTool: vi.fn(async (_id: string, tool: string, params: Record<string, unknown>) => {
      if (tool === "list_pages") return { items: [{ id: "design", title: "Design", path: "wiki/design.md" }] };
      if (tool === "read_page") return { items: [{ ref: (params.refs as string[])[0], content: "---\ntitle: Design\nsources:\n  - proposal.md\n---\nBody" }] };
      if (tool === "read_raw") return { items: [{ filename: (params.filenames as string[])[0], content: "Original" }] };
      throw new Error(`unexpected ${tool}`);
    }) };
    const service = new WikiAccessService(async () => [wiki("wiki-a", "A")], knowledge as never);
    const listed = await service.list("wiki-a", undefined, 20);
    const read = await service.read([listed.items[0]!.page_ref], 1000);
    const sourceRef = read.items[0]!.source_refs[0]!;

    expect(sourceRef).toMatch(/^cbrain-source:/);
    await expect(service.readSources([sourceRef], 1000)).resolves.toMatchObject({ items: [{ content: "Original" }] });
    await expect(service.read(["cbrain-page:not-valid"], 1000)).rejects.toThrow("invalid page_ref");
  });

  it("requests only bounded related pages instead of transferring the whole graph",async()=>{const knowledge={callTool:vi.fn(async()=>({items:[{id:"b",path:"wiki/b.md",hop:1},{id:"c",path:"wiki/c.md",hop:2}]}))};const service=new WikiAccessService(async()=>[wiki("wiki-a")],knowledge as never);const listedKnowledge={callTool:vi.fn(async()=>({items:[{id:"a",path:"wiki/a.md",title:"A"}]}))};const listing=new WikiAccessService(async()=>[wiki("wiki-a")],listedKnowledge as never);const listed=await listing.list("wiki-a");const related=await service.related(listed.items[0]!.page_ref,2,20);expect(knowledge.callTool).toHaveBeenCalledWith("wiki-a","related_pages",{ref:"wiki/a.md",depth:2,limit:20});expect(related.items.map((item)=>item.id)).toEqual(["b","c"])});
});
