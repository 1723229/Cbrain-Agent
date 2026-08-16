import { describe, expect, it } from "vitest";

import { AGENT_TOOLS, GATEWAY_TOOL_ANNOTATIONS, WIKI_TOOLS, WORKSPACE_BIND_TOOL, WORKSPACE_REBIND_TOOL, WORKSPACE_STATUS_TOOL, WORKSPACE_UNBIND_TOOL, WORKSPACE_TOOLS, withContextSchema } from "./tools.js";

describe("gateway tool contract", () => {
  it("exposes the exact task-oriented agent surface", () => {
    expect(GATEWAY_TOOL_ANNOTATIONS).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect([...WORKSPACE_TOOLS, ...AGENT_TOOLS].map((tool) => tool.name)).toEqual([
      "workspace_bind", "workspace_status", "workspace_rebind", "workspace_unbind",
      "memory_status", "memory_profile", "memory_search", "conversation_search", "scene_read",
      "skill_search", "skill_get", "skill_file_read", "knowledge_resources",
      "wiki_search", "wiki_list", "wiki_read", "wiki_source_read", "wiki_related",
      "code_search", "code_explore", "code_relationships", "code_impact", "code_node", "code_files",
    ]);
    expect(withContextSchema(AGENT_TOOLS[0]!).inputSchema.required).toContain("context_id");
    expect(AGENT_TOOLS.find((tool) => tool.name === "skill_search")?.inputSchema.required).toEqual([]);
    expect(AGENT_TOOLS.find((tool) => tool.name === "wiki_search")?.inputSchema.required).toEqual(["query"]);
    expect(AGENT_TOOLS.filter((tool)=>tool.knowledge?.type==="code-graph").map((tool)=>tool.knowledge?.remoteName)).toEqual(["search","explore","impact","node","files"]);
    expect(WIKI_TOOLS.filter((tool)=>tool.knowledge).map((tool)=>tool.knowledge?.remoteName)).toEqual(["search","list_pages","read_page","read_raw","related_pages"]);
  });
  it("exposes a small standalone Wiki/RAG surface without context or agent identifiers", () => {
    expect(WIKI_TOOLS.map((tool) => tool.name)).toEqual([
      "wiki_resources", "wiki_search", "wiki_list", "wiki_read", "wiki_source_read", "wiki_related",
    ]);
    for (const tool of WIKI_TOOLS) {
      expect(tool.inputSchema.properties).not.toHaveProperty("context_id");
      expect(tool.inputSchema.properties).not.toHaveProperty("team_id");
      expect(tool.inputSchema.properties).not.toHaveProperty("agent_id");
    }
  });
  it("exposes workspace binding without requiring an existing memory context",()=>{
    expect(WORKSPACE_BIND_TOOL.name).toBe("workspace_bind");
    expect(WORKSPACE_BIND_TOOL.inputSchema.required).toEqual(["binding_request_id","team_id","agent_id"]);
    expect(WORKSPACE_BIND_TOOL.inputSchema.properties).not.toHaveProperty("context_id");
    expect([WORKSPACE_STATUS_TOOL,WORKSPACE_REBIND_TOOL,WORKSPACE_UNBIND_TOOL].map((tool)=>tool.name)).toEqual(["workspace_status","workspace_rebind","workspace_unbind"]);
    for(const tool of [WORKSPACE_STATUS_TOOL,WORKSPACE_REBIND_TOOL,WORKSPACE_UNBIND_TOOL])expect(tool.inputSchema.properties).not.toHaveProperty("context_id");
  });
});
