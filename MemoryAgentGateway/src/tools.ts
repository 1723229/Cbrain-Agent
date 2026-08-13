export interface GatewayTool {
  name: string; description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[] };
  knowledge?: { type: "wiki" | "code-graph"; idField: "wiki_id" | "code_graph_id"; remoteName: string };
}
export const GATEWAY_TOOL_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object" as const, properties, required });
const text = (description: string) => ({ type: "string", description });
const id = (kind: string) => text(`Accessible ${kind} resource ID`);
export const WORKSPACE_BIND_TOOL: GatewayTool = {
  name: "workspace_bind",
  description: "Bind the current unbound workspace to a Team and Agent using the opaque binding request supplied by Hiper.",
  inputSchema: objectSchema({
    binding_request_id: text("Opaque binding request ID supplied by the Hiper workspace prompt"),
    team_id: text("Selected Team ID"),
    agent_id: text("Selected Agent ID"),
  }, ["binding_request_id", "team_id", "agent_id"]),
};
export const WORKSPACE_STATUS_TOOL: GatewayTool = {
  name: "workspace_status",
  description: "Show the current Hiper Team and Agent binding for a workspace. Use when the user asks which memory scope is active.",
  inputSchema: objectSchema({ workspace_key: text("Opaque workspace key supplied by Hiper context") }, ["workspace_key"]),
};
export const WORKSPACE_REBIND_TOOL: GatewayTool = {
  name: "workspace_rebind",
  description: "Start an explicit Team and Agent reselection for the current workspace. Call only when the user asks to change its binding.",
  inputSchema: objectSchema({
    workspace_key: text("Opaque workspace key supplied by Hiper context"),
    workspace_label: text("Workspace label supplied by Hiper context"),
    host: text("Host supplied by Hiper context"),
    session_id: text("Session ID supplied by Hiper context"),
    workspace: text("Workspace path supplied by Hiper context"),
  }, ["workspace_key","workspace_label","host","session_id","workspace"]),
};
export const WORKSPACE_UNBIND_TOOL: GatewayTool = {
  name: "workspace_unbind",
  description: "Remove the current workspace binding. Call only after the user explicitly asks to unbind it.",
  inputSchema: objectSchema({ workspace_key: text("Opaque workspace key supplied by Hiper context") }, ["workspace_key"]),
};
export const WORKSPACE_TOOLS = [WORKSPACE_BIND_TOOL, WORKSPACE_STATUS_TOOL, WORKSPACE_REBIND_TOOL, WORKSPACE_UNBIND_TOOL] as const;
export const GATEWAY_TOOLS: GatewayTool[] = [
  { name: "memory_status", description: "Show the active memory context and gateway status.", inputSchema: objectSchema({}) },
  { name: "memory_profile", description: "Read this agent's prompt, L3 profile, and L2 scene index.", inputSchema: objectSchema({}) },
  { name: "memory_search", description: "Search structured long-term memory (L1).", inputSchema: objectSchema({ query:text("Search query"),limit:{type:"integer",minimum:1,maximum:20},type:text("Optional memory type") },["query"]) },
  { name: "conversation_search", description: "Search raw conversation memory (L0), across sessions by default.", inputSchema: objectSchema({ query:text("Search query"),limit:{type:"integer",minimum:1,maximum:20},session_id:text("Optional session filter") },["query"]) },
  { name:"scene_list",description:"List L2 scene-memory files.",inputSchema:objectSchema({path_prefix:text("Optional path prefix")}) },
  { name:"scene_read",description:"Read one L2 scene-memory file.",inputSchema:objectSchema({path:text("Relative scene path")},["path"]) },
  { name:"profile_read",description:"Read the L3 profile.",inputSchema:objectSchema({}) },
  { name:"skill_list",description:"List Skills available to this Team and Agent.",inputSchema:objectSchema({limit:{type:"integer",minimum:1,maximum:1000},offset:{type:"integer",minimum:0}}) },
  { name:"skill_search",description:"Search available Skills semantically.",inputSchema:objectSchema({query:text("Search query"),top_k:{type:"integer",minimum:1,maximum:50}},["query"]) },
  { name:"skill_get",description:"Read a Skill including SKILL.md and manifest.",inputSchema:objectSchema({skill_id:id("Skill"),version:{type:"integer",minimum:1}},["skill_id"]) },
  { name:"skill_file_read",description:"Read one file from a Skill package.",inputSchema:objectSchema({skill_id:id("Skill"),path:text("Package-relative path"),version:{type:"integer",minimum:1},encoding:{type:"string",enum:["utf-8","base64"]}},["skill_id","path"]) },
  { name:"skill_listing",description:"Read a compact Skill listing suitable for choosing a Skill.",inputSchema:objectSchema({query:text("Optional query"),char_budget:{type:"integer",minimum:0,maximum:64000}}) },
  { name:"knowledge_resources",description:"List accessible Wiki and CodeGraph resources bound to this agent.",inputSchema:objectSchema({}) },
  knowledge("wiki_info","Get bound Wiki metadata.","wiki","wiki_id","get_info",{wiki_id:id("Wiki")},["wiki_id"]),
  knowledge("wiki_search","Search bound Wiki pages.","wiki","wiki_id","search",{wiki_id:id("Wiki"),query:text("Search query"),limit:{type:"integer"}},["wiki_id","query"]),
  knowledge("wiki_read","Read bound Wiki pages by reference.","wiki","wiki_id","read_page",{wiki_id:id("Wiki"),refs:{type:"array",items:{type:"string"}}},["wiki_id","refs"]),
  knowledge("wiki_list","List pages in a bound Wiki.","wiki","wiki_id","list_pages",{wiki_id:id("Wiki")},["wiki_id"]),
  knowledge("wiki_graph","Read a bound Wiki knowledge graph.","wiki","wiki_id","get_graph",{wiki_id:id("Wiki")},["wiki_id"]),
  knowledge("wiki_raw_list","List original files uploaded to a bound Wiki.","wiki","wiki_id","list_raw",{wiki_id:id("Wiki")},["wiki_id"]),
  knowledge("wiki_raw_read","Read original uploaded Wiki files.","wiki","wiki_id","read_raw",{wiki_id:id("Wiki"),filenames:{type:"array",items:{type:"string"}}},["wiki_id","filenames"]),
  knowledge("code_info","Get bound CodeGraph metadata.","code-graph","code_graph_id","get_info",{code_graph_id:id("CodeGraph")},["code_graph_id"]),
  knowledge("code_search","Search symbols in a bound CodeGraph.","code-graph","code_graph_id","search",{code_graph_id:id("CodeGraph"),query:text("Symbol name"),kind:text("Optional kind"),limit:{type:"integer"}},["code_graph_id","query"]),
  knowledge("code_explore","Explore relevant source files.","code-graph","code_graph_id","explore",{code_graph_id:id("CodeGraph"),query:text("Search query"),maxFiles:{type:"integer"}},["code_graph_id","query"]),
  ...["callers","callees","impact"].map((remoteName) => knowledge(`code_${remoteName}`,`CodeGraph ${remoteName} query.`,"code-graph","code_graph_id",remoteName,{code_graph_id:id("CodeGraph"),symbol:text("Symbol name"),limit:{type:"integer"},depth:{type:"integer"}},["code_graph_id","symbol"])),
  knowledge("code_node","Get a CodeGraph symbol node.","code-graph","code_graph_id","node",{code_graph_id:id("CodeGraph"),symbol:text("Symbol name"),includeCode:{type:"boolean"},file:text("Optional file"),line:{type:"integer"}},["code_graph_id","symbol"]),
  knowledge("code_status","Get CodeGraph indexing status.","code-graph","code_graph_id","status",{code_graph_id:id("CodeGraph")},["code_graph_id"]),
  knowledge("code_files","List files in a CodeGraph.","code-graph","code_graph_id","files",{code_graph_id:id("CodeGraph"),path:text("Path prefix"),pattern:text("Glob"),format:{type:"string",enum:["tree","flat","grouped"]}},["code_graph_id"]),
];
function knowledge(name:string,description:string,type:"wiki"|"code-graph",idField:"wiki_id"|"code_graph_id",remoteName:string,properties:Record<string,unknown>,required:string[]):GatewayTool{return{name,description,inputSchema:objectSchema(properties,required),knowledge:{type,idField,remoteName}}}
export function withContextSchema(tool: GatewayTool) { return { ...tool, inputSchema: { ...tool.inputSchema, properties: { context_id: text("Opaque context ID supplied by SessionStart"), ...tool.inputSchema.properties }, required: ["context_id", ...tool.inputSchema.required] }, annotations: GATEWAY_TOOL_ANNOTATIONS }; }
