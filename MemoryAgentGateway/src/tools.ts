export interface GatewayTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[] };
  knowledge?: { type: "wiki" | "code-graph"; remoteName: string };
}

export const GATEWAY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object" as const, properties, required });
const text = (description: string) => ({ type: "string", description });
const integer = (description: string, minimum: number, maximum: number) => ({ type: "integer", description, minimum, maximum });
const stringArray = (description: string) => ({ type: "array", description, items: { type: "string" } });
const resourceId = (kind: string) => text(`Accessible ${kind} resource ID returned by knowledge_resources`);

export const WORKSPACE_BIND_TOOL: GatewayTool = {
  name: "workspace_bind",
  description: "Bind the current unbound workspace to a Team and Agent using the opaque binding request supplied by Cbrain.",
  inputSchema: objectSchema({ binding_request_id: text("Opaque binding request ID supplied by Cbrain"), team_id: text("Selected Team ID"), agent_id: text("Selected Agent ID") }, ["binding_request_id", "team_id", "agent_id"]),
};
export const WORKSPACE_STATUS_TOOL: GatewayTool = {
  name: "workspace_status",
  description: "Show the current Cbrain Team and Agent binding for a workspace.",
  inputSchema: objectSchema({ workspace_key: text("Opaque workspace key supplied by Cbrain context") }, ["workspace_key"]),
};
export const WORKSPACE_REBIND_TOOL: GatewayTool = {
  name: "workspace_rebind",
  description: "Start an explicit Team and Agent reselection for the current workspace. Call only when the user asks to change its binding.",
  inputSchema: objectSchema({ workspace_key: text("Opaque workspace key"), workspace_label: text("Workspace label"), host: text("Client host"), session_id: text("Client session ID"), workspace: text("Workspace path") }, ["workspace_key", "workspace_label", "host", "session_id", "workspace"]),
};
export const WORKSPACE_UNBIND_TOOL: GatewayTool = {
  name: "workspace_unbind",
  description: "Remove the current workspace binding. Call only after the user explicitly asks to unbind it.",
  inputSchema: objectSchema({ workspace_key: text("Opaque workspace key supplied by Cbrain context") }, ["workspace_key"]),
};
export const WORKSPACE_TOOLS = [WORKSPACE_BIND_TOOL, WORKSPACE_STATUS_TOOL, WORKSPACE_REBIND_TOOL, WORKSPACE_UNBIND_TOOL] as const;

const wikiIds = { wiki_ids: stringArray("Optional Wiki IDs to restrict. Omit to search every Wiki available in the active scope.") };
const wikiSearch: GatewayTool = { name: "wiki_search", description: "Search one or more available Wiki/RAG resources and return ranked page references.", inputSchema: objectSchema({ query: text("Natural-language or keyword query"), ...wikiIds, limit: integer("Global result limit", 1, 20) }, ["query"]), knowledge: { type: "wiki", remoteName: "search" } };
const wikiList: GatewayTool = { name: "wiki_list", description: "List pages in one available Wiki/RAG resource.", inputSchema: objectSchema({ wiki_id: resourceId("Wiki"), cursor: text("Optional pagination cursor"), limit: integer("Page size", 1, 100) }, ["wiki_id"]), knowledge: { type: "wiki", remoteName: "list_pages" } };
const wikiRead: GatewayTool = { name: "wiki_read", description: "Read Wiki/RAG pages using opaque page references returned by wiki_search or wiki_list.", inputSchema: objectSchema({ page_refs: stringArray("Opaque page references"), max_chars: integer("Maximum characters returned per page", 256, 100000) }, ["page_refs"]), knowledge: { type: "wiki", remoteName: "read_page" } };
const wikiSourceRead: GatewayTool = { name: "wiki_source_read", description: "Read original source documents using opaque source references returned by wiki_read.", inputSchema: objectSchema({ source_refs: stringArray("Opaque source references"), max_chars: integer("Maximum characters returned per source", 256, 100000) }, ["source_refs"]), knowledge: { type: "wiki", remoteName: "read_raw" } };
const wikiRelated: GatewayTool = { name: "wiki_related", description: "Traverse bounded Wiki relationships around a page for supporting or related knowledge.", inputSchema: objectSchema({ page_ref: text("Opaque page reference"), depth: integer("Relationship depth", 1, 2), limit: integer("Maximum related pages", 1, 20) }, ["page_ref"]), knowledge: { type: "wiki", remoteName: "related_pages" } };

export const AGENT_TOOLS: GatewayTool[] = [
  { name: "memory_status", description: "Show the active Cbrain memory context and asynchronous extraction status.", inputSchema: objectSchema({}) },
  { name: "memory_profile", description: "Read the Agent prompt, L3 profile and a paginated L2 scene index.", inputSchema: objectSchema({ scene_prefix: text("Optional L2 scene path prefix"), cursor: text("Optional L2 pagination cursor"), limit: integer("L2 page size", 1, 100) }) },
  { name: "memory_search", description: "Search structured long-term memory (L1).", inputSchema: objectSchema({ query: text("Search query"), limit: integer("Result limit", 1, 20), type: text("Optional memory type") }, ["query"]) },
  { name: "conversation_search", description: "Search raw conversation memory (L0), across sessions by default.", inputSchema: objectSchema({ query: text("Search query"), limit: integer("Result limit", 1, 20), session_id: text("Optional session filter") }, ["query"]) },
  { name: "scene_read", description: "Read one L2 scene-memory file selected from memory_profile.", inputSchema: objectSchema({ path: text("Relative scene path") }, ["path"]) },
  { name: "skill_search", description: "Search available Skills, or list them when query is omitted.", inputSchema: objectSchema({ query: text("Optional semantic search query"), limit: integer("Result limit", 1, 50), offset: integer("List offset when query is omitted", 0, 1000000) }) },
  { name: "skill_get", description: "Read a Skill including SKILL.md and manifest.", inputSchema: objectSchema({ skill_id: resourceId("Skill"), version: integer("Optional Skill version", 1, 1000000) }, ["skill_id"]) },
  { name: "skill_file_read", description: "Read one file from a Skill package.", inputSchema: objectSchema({ skill_id: resourceId("Skill"), path: text("Package-relative path"), version: integer("Optional Skill version", 1, 1000000), encoding: { type: "string", enum: ["utf-8", "base64"] } }, ["skill_id", "path"]) },
  { name: "knowledge_resources", description: "List Wiki/RAG and CodeGraph resources available to this Agent.", inputSchema: objectSchema({}) },
  wikiSearch, wikiList, wikiRead, wikiSourceRead, wikiRelated,
  knowledge("code_search", "Search symbols in a CodeGraph.", "code-graph", "search", { code_graph_id: resourceId("CodeGraph"), query: text("Symbol name"), kind: text("Optional symbol kind"), limit: integer("Result limit", 1, 50) }, ["code_graph_id", "query"]),
  knowledge("code_explore", "Find source files relevant to a development question.", "code-graph", "explore", { code_graph_id: resourceId("CodeGraph"), query: text("Development question"), maxFiles: integer("Maximum files", 1, 50) }, ["code_graph_id", "query"]),
  { name:"code_relationships",description:"Read callers, callees, or both relationships for a symbol.",inputSchema:objectSchema({code_graph_id:resourceId("CodeGraph"),symbol:text("Symbol name"),direction:{type:"string",enum:["callers","callees","both"]},limit:integer("Result limit",1,100)},["code_graph_id","symbol"]) },
  knowledge("code_impact", "Analyze the transitive impact of changing a symbol.", "code-graph", "impact", { code_graph_id: resourceId("CodeGraph"), symbol: text("Symbol name"), depth: integer("Traversal depth", 1, 10), limit: integer("Result limit", 1, 100) }, ["code_graph_id", "symbol"]),
  knowledge("code_node", "Read a CodeGraph symbol node and optional source.", "code-graph", "node", { code_graph_id: resourceId("CodeGraph"), symbol: text("Symbol name"), includeCode: { type: "boolean" }, file: text("Optional file"), line: integer("Optional source line", 1, 10000000) }, ["code_graph_id", "symbol"]),
  knowledge("code_files", "List files in a CodeGraph.", "code-graph", "files", { code_graph_id: resourceId("CodeGraph"), path: text("Path prefix"), pattern: text("Glob pattern"), format: { type: "string", enum: ["tree", "flat", "grouped"] } }, ["code_graph_id"]),
];

export const WIKI_TOOLS: GatewayTool[] = [
  { name: "wiki_resources", description: "List every Wiki/RAG resource available through the authenticated API Key and its Agent bindings.", inputSchema: objectSchema({}) },
  wikiSearch, wikiList, wikiRead, wikiSourceRead, wikiRelated,
];

function knowledge(name: string, description: string, type: "wiki" | "code-graph", remoteName: string, properties: Record<string, unknown>, required: string[]): GatewayTool {
  return { name, description, inputSchema: objectSchema(properties, required), knowledge: { type, remoteName } };
}

export function withContextSchema(tool: GatewayTool) {
  return { ...tool, inputSchema: { ...tool.inputSchema, properties: { context_id: text("Opaque context ID supplied by SessionStart"), ...tool.inputSchema.properties }, required: ["context_id", ...tool.inputSchema.required] }, annotations: GATEWAY_TOOL_ANNOTATIONS };
}
