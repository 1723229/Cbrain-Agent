import { describe, expect, it, vi } from "vitest";

import { dispatchAgentTool, dispatchWikiTool } from "./mcp-server.js";
import { AGENT_TOOLS, WIKI_TOOLS } from "./tools.js";

describe("MCP dispatch contract", () => {
  it("dispatches every advertised Agent tool", async () => {
    const service = {
      context: { contextId: "ctx", teamId: "team", agentId: "agent", agentName: "Agent", sessionId: "session" },
      extractionStatus: vi.fn(() => null), profile: vi.fn(async()=>"profile"), searchMemory:vi.fn(async()=>"memory"), searchConversation:vi.fn(async()=>"conversation"), readScene:vi.fn(async()=>"scene"),
      findSkills:vi.fn(async()=>"skills"),getSkill:vi.fn(async()=>"skill"),readSkillFile:vi.fn(async()=>"file"),listKnowledgeResources:vi.fn(async()=>[]),
      wikiSearch:vi.fn(async()=>"wiki-search"),wikiList:vi.fn(async()=>"wiki-list"),wikiRead:vi.fn(async()=>"wiki-read"),wikiSourceRead:vi.fn(async()=>"source"),wikiRelated:vi.fn(async()=>"related"),
      codeRelationships:vi.fn(async()=>"relationships"),callKnowledge:vi.fn(async()=>"code"),
    };
    const args:Record<string,Record<string,unknown>>={
      memory_status:{},memory_profile:{},memory_search:{query:"q"},conversation_search:{query:"q"},scene_read:{path:"scene.md"},
      skill_search:{},skill_get:{skill_id:"skill"},skill_file_read:{skill_id:"skill",path:"SKILL.md"},knowledge_resources:{},
      wiki_search:{query:"q"},wiki_list:{wiki_id:"wiki"},wiki_read:{page_refs:["page"]},wiki_source_read:{source_refs:["source"]},wiki_related:{page_ref:"page"},
      code_search:{code_graph_id:"cg",query:"q"},code_explore:{code_graph_id:"cg",query:"q"},code_relationships:{code_graph_id:"cg",symbol:"s"},code_impact:{code_graph_id:"cg",symbol:"s"},code_node:{code_graph_id:"cg",symbol:"s"},code_files:{code_graph_id:"cg"},
    };
    for(const tool of AGENT_TOOLS)await expect(dispatchAgentTool(service as never,tool.name,args[tool.name]!)).resolves.toBeDefined();
    expect(Object.keys(args)).toEqual(AGENT_TOOLS.map((tool)=>tool.name));
    expect(service.callKnowledge).toHaveBeenCalledTimes(5);
  });

  it("dispatches every advertised standalone Wiki tool",async()=>{
    const service={resources:vi.fn(async()=>[]),search:vi.fn(async()=>[]),list:vi.fn(async()=>[]),read:vi.fn(async()=>[]),readSources:vi.fn(async()=>[]),related:vi.fn(async()=>[])};
    const args:Record<string,Record<string,unknown>>={wiki_resources:{},wiki_search:{query:"q"},wiki_list:{wiki_id:"wiki"},wiki_read:{page_refs:["page"]},wiki_source_read:{source_refs:["source"]},wiki_related:{page_ref:"page"}};
    for(const tool of WIKI_TOOLS)await expect(dispatchWikiTool(service as never,tool.name,args[tool.name]!)).resolves.toBeDefined();
    expect(Object.keys(args)).toEqual(WIKI_TOOLS.map((tool)=>tool.name));
  });
});
