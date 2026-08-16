import { describe, expect, it, vi } from "vitest";
import { CoreClient } from "./core-client.js";
import { AgentGatewayService } from "./service.js";
import type { SessionContext } from "./types.js";

const context: SessionContext = {
  contextId: "ctx", principalId: "principal", teamId: "team", userId: "user", agentId: "agent",
  host: "codex", sessionId: "session", workspace: "/repo", createdAt: 1, expiresAt: 2,
};
const coreConfig = { baseUrl: "http://core", serviceId: "service", timeoutMs: 1000 };

describe("AgentGatewayService automatic recall", () => {
  it("returns the combined profile with a bounded, paginated L2 index",async()=>{
    const core=new CoreClient(coreConfig,context);vi.spyOn(core,"readProfile").mockResolvedValue({content:"L3"});vi.spyOn(core,"listScenes").mockResolvedValue({entries:Array.from({length:3},(_,i)=>({path:`project/${i}.md`})),total:3});vi.spyOn(core,"agentAndAssets").mockResolvedValue({agent:{prompt:"Prompt"},items:[]});const service=new AgentGatewayService({core:coreConfig,knowledge:{} as never},context,core);
    const first=await service.profile("project/",undefined,2) as {l2:{entries:unknown[];next_cursor:string}};expect(first.l2.entries).toHaveLength(2);expect(first.l2.next_cursor).toMatch(/^cbrain-scene:/);const second=await service.profile("project/",first.l2.next_cursor,2) as {l2:{entries:unknown[];next_cursor:null}};expect(second.l2.entries).toHaveLength(1);expect(second.l2.next_cursor).toBeNull();expect(core.listScenes).toHaveBeenCalledWith("project/");
  });
  it("injects L1/L2/L3 in parallel and leaves raw L0 to the explicit conversation tool", async () => {
    const core = new CoreClient(coreConfig, context);
    const memory = vi.spyOn(core, "searchMemory").mockResolvedValue({ items: [
      { id: "memory-1", type: "episodic", content: "Use pnpm for this repository.", score: 0.91, timestamp: "2026-08-11" },
      { id: "empty", type: "episodic", content: "   ", score: 0.99 },
    ] });
    const conversation = vi.spyOn(core, "searchConversation").mockResolvedValue({ messages: [
      { id: "raw-1", role: "user", content: "干嘛呢", score: 0.99 },
    ] });
    const profile = vi.spyOn(core, "readProfile").mockResolvedValue({ content: "User prefers concise answers." });
    const scenes = vi.spyOn(core, "listScenes").mockResolvedValue({ entries: [{ path: "scene_blocks/project.md" }], total: 1 });
    const service = new AgentGatewayService({ core: coreConfig, knowledge: {} as never, recallTimeoutMs: 250 }, context, core);

    const result = await service.renderRecallContext("Which package manager does this repository use?");

    expect(memory).toHaveBeenCalledWith("Which package manager does this repository use?", 5, undefined, 250);
    expect(profile).toHaveBeenCalledWith(250);
    expect(scenes).toHaveBeenCalledWith("", 250);
    expect(conversation).not.toHaveBeenCalled();
    expect(result).toContain("<relevant-memories>");
    expect(result).toContain("[episodic] Use pnpm for this repository.");
    expect(result).toContain("<user-persona>\nUser prefers concise answers.");
    expect(result).toContain("<scene-navigation>\n- scene_blocks/project.md");
    expect(result).not.toContain("memory-1");
    expect(result).not.toContain("score");
    expect(result).not.toContain("timestamp");
    expect(result).not.toContain("干嘛呢");
  });

  it("skips automatic recall for greetings and filters explicitly low-score results",async()=>{
    const core=new CoreClient(coreConfig,context);const memory=vi.spyOn(core,"searchMemory").mockResolvedValue({items:[{content:"irrelevant",score:0.1},{content:"compatible item without score"}]});const profile=vi.spyOn(core,"readProfile").mockResolvedValue({content:"profile"});const scenes=vi.spyOn(core,"listScenes").mockResolvedValue({entries:[]});const service=new AgentGatewayService({core:coreConfig,knowledge:{} as never,recallMinScore:0.75},context,core);
    await expect(service.renderRecallContext("干嘛呢")).resolves.toBe("");expect(memory).not.toHaveBeenCalled();expect(profile).not.toHaveBeenCalled();expect(scenes).not.toHaveBeenCalled();
    const result=await service.renderRecallContext("repository package manager decision");expect(result).not.toContain("irrelevant");expect(result).toContain("compatible item without score");
  });

  it("always renders valid JSON when session context exceeds its budget",async()=>{
    const core=new CoreClient(coreConfig,context);vi.spyOn(core,"agentAndAssets").mockResolvedValue({agent:{prompt:"x".repeat(1000)},items:[]});vi.spyOn(core,"skillListing").mockResolvedValue({content:"y".repeat(1000)});vi.spyOn(core,"listBoundKnowledge").mockResolvedValue(Array.from({length:20},(_,i)=>({knowledge_id:`k${i}`,type:"wiki",name:"z".repeat(100),summary:"s".repeat(200)})) as never);const service=new AgentGatewayService({core:coreConfig,knowledge:{} as never,profileMaxChars:400},context,core);const rendered=await service.renderSessionContext("ctx");const json=rendered.slice(rendered.indexOf("\n")+1,rendered.lastIndexOf("\n"));expect(()=>JSON.parse(json)).not.toThrow();expect(rendered.length).toBeLessThan(550);
  });

  it("injects nothing when L1 has no usable content even if stable layers exist", async () => {
    const core = new CoreClient(coreConfig, context);
    vi.spyOn(core, "searchMemory").mockResolvedValue({ items: [{ content: "" }] });
    vi.spyOn(core, "readProfile").mockResolvedValue({ content: "Unrelated stable profile" });
    vi.spyOn(core, "listScenes").mockResolvedValue({ entries: [{ path: "scene_blocks/unrelated.md" }] });
    const service = new AgentGatewayService({ core: coreConfig, knowledge: {} as never }, context, core);
    await expect(service.renderRecallContext("hello")).resolves.toBe("");
  });

  it("degrades stable layers independently after L1 establishes relevance", async () => {
    const core = new CoreClient(coreConfig, context);
    vi.spyOn(core, "searchMemory").mockResolvedValue({ items: [{ type: "instruction", content: "Relevant memory" }] });
    vi.spyOn(core, "readProfile").mockRejectedValue(new Error("timeout"));
    vi.spyOn(core, "listScenes").mockResolvedValue({ entries: [{ path: "scene_blocks/relevant.md" }] });
    const service = new AgentGatewayService({ core: coreConfig, knowledge: {} as never }, context, core);
    const result=await service.renderRecallContext("relevant query");
    expect(result).toContain("Relevant memory");
    expect(result).toContain("scene_blocks/relevant.md");
    expect(result).not.toContain("user-persona");
  });

  it("keeps raw L0 available through explicit conversation search", async () => {
    const core = new CoreClient(coreConfig, context);
    const conversation = vi.spyOn(core, "searchConversation").mockResolvedValue({ messages: [{ role: "user", content: "original text" }] });
    const service = new AgentGatewayService({ core: coreConfig, knowledge: {} as never }, context, core);
    await expect(service.searchConversation("original", 3, "older-session")).resolves.toEqual({ messages: [{ role: "user", content: "original text" }] });
    expect(conversation).toHaveBeenCalledWith("original", 3, "older-session");
  });
});
