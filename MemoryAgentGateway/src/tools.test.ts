import { describe, expect, it } from "vitest";

import { GATEWAY_TOOL_ANNOTATIONS, GATEWAY_TOOLS, WORKSPACE_BIND_TOOL, WORKSPACE_REBIND_TOOL, WORKSPACE_STATUS_TOOL, WORKSPACE_UNBIND_TOOL, withContextSchema } from "./tools.js";

describe("gateway tool contract", () => {
  it("exposes the complete read-only memory and knowledge surface", () => {
    expect(GATEWAY_TOOLS.length).toBeGreaterThanOrEqual(28);
    expect(GATEWAY_TOOL_ANNOTATIONS).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(GATEWAY_TOOLS.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "memory_search",
      "conversation_search",
      "wiki_search",
      "wiki_graph",
      "wiki_raw_read",
      "skill_search",
      "code_search",
      "code_status",
    ]));
    expect(withContextSchema(GATEWAY_TOOLS[0]!).inputSchema.required).toContain("context_id");
  });
  it("exposes workspace binding without requiring an existing memory context",()=>{
    expect(WORKSPACE_BIND_TOOL.name).toBe("workspace_bind");
    expect(WORKSPACE_BIND_TOOL.inputSchema.required).toEqual(["binding_request_id","team_id","agent_id"]);
    expect(WORKSPACE_BIND_TOOL.inputSchema.properties).not.toHaveProperty("context_id");
    expect([WORKSPACE_STATUS_TOOL,WORKSPACE_REBIND_TOOL,WORKSPACE_UNBIND_TOOL].map((tool)=>tool.name)).toEqual(["workspace_status","workspace_rebind","workspace_unbind"]);
    for(const tool of [WORKSPACE_STATUS_TOOL,WORKSPACE_REBIND_TOOL,WORKSPACE_UNBIND_TOOL])expect(tool.inputSchema.properties).not.toHaveProperty("context_id");
  });
});
