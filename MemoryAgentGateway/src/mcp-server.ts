import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AgentGatewayService } from "./service.js";
import { GATEWAY_TOOLS, GATEWAY_TOOL_ANNOTATIONS, WORKSPACE_TOOLS, withContextSchema } from "./tools.js";

export interface WorkspaceBindInput { bindingRequestId: string; teamId: string; agentId: string }
export interface WorkspaceSelectionInput { workspaceKey:string;workspaceLabel:string;host:string;sessionId:string;workspace:string }
export interface WorkspaceActions {
  bind(input:WorkspaceBindInput):Promise<unknown>;
  status(workspaceKey:string):Promise<unknown>;
  rebind(input:WorkspaceSelectionInput):Promise<unknown>;
  unbind(workspaceKey:string):Promise<unknown>;
}

export function createMcpServer(
  resolveService: (contextId: string) => AgentGatewayService,
  workspaceActions: WorkspaceActions,
): Server {
  const server = new Server({ name: "cbrain-agent-gateway", version: "0.2.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    ...WORKSPACE_TOOLS.map((tool)=>({ ...tool, annotations: { ...GATEWAY_TOOL_ANNOTATIONS, readOnlyHint: tool.name==="workspace_status" } })),
    ...GATEWAY_TOOLS.map(withContextSchema),
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (name === "workspace_bind") {
        const data = await workspaceActions.bind({
          bindingRequestId: stringArg(args, "binding_request_id"),
          teamId: stringArg(args, "team_id"),
          agentId: stringArg(args, "agent_id"),
        });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      if(name==="workspace_status")return toolResult(await workspaceActions.status(stringArg(args,"workspace_key")));
      if(name==="workspace_rebind")return toolResult(await workspaceActions.rebind({workspaceKey:stringArg(args,"workspace_key"),workspaceLabel:stringArg(args,"workspace_label"),host:stringArg(args,"host"),sessionId:stringArg(args,"session_id"),workspace:stringArg(args,"workspace")}));
      if(name==="workspace_unbind")return toolResult(await workspaceActions.unbind(stringArg(args,"workspace_key")));
      const tool = GATEWAY_TOOLS.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      const service = resolveService(stringArg(args, "context_id"));
      const data = tool.knowledge ? await callKnowledge(service, tool.knowledge, args) : await callMemory(service, name, args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (error) { return { content: [{ type: "text", text: `Error: ${message(error)}` }], isError: true }; }
  });
  return server;
}
function toolResult(data:unknown){return{content:[{type:"text" as const,text:JSON.stringify(data,null,2)}]}}

async function callKnowledge(service: AgentGatewayService, spec: NonNullable<(typeof GATEWAY_TOOLS)[number]["knowledge"]>, args: Record<string, unknown>): Promise<unknown> {
  const resourceId = stringArg(args, spec.idField); const params = { ...args }; delete params[spec.idField]; delete params.context_id;
  return service.callKnowledge(resourceId, spec.type, spec.remoteName, params);
}
function callMemory(service: AgentGatewayService, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "memory_status": return Promise.resolve({ context_id: service.context.contextId, team_id: service.context.teamId, agent_id: service.context.agentId, agent_name: service.context.agentName, session_id: service.context.sessionId, skill_extraction: service.extractionStatus() });
    case "memory_profile": return service.profile();
    case "memory_search": return service.searchMemory(stringArg(args,"query"),numberArg(args,"limit",5),optionalString(args,"type"));
    case "conversation_search": return service.searchConversation(stringArg(args,"query"),numberArg(args,"limit",5),optionalString(args,"session_id"));
    case "scene_list": return service.listScenes(optionalString(args,"path_prefix")??"");
    case "scene_read": return service.readScene(stringArg(args,"path"));
    case "profile_read": return service.readProfile();
    case "skill_list": return service.listSkills(numberArg(args,"limit",50),numberArg(args,"offset",0));
    case "skill_search": return service.searchSkills(stringArg(args,"query"),numberArg(args,"top_k",10));
    case "skill_get": return service.getSkill(stringArg(args,"skill_id"),optionalNumber(args,"version"));
    case "skill_file_read": return service.readSkillFile(stringArg(args,"skill_id"),stringArg(args,"path"),optionalNumber(args,"version"),optionalString(args,"encoding"));
    case "skill_listing": return service.skillListing(optionalString(args,"query")??"",numberArg(args,"char_budget",8000));
    case "knowledge_resources": return service.listKnowledgeResources();
    default: return Promise.reject(new Error(`Unsupported tool: ${name}`));
  }
}
function stringArg(args:Record<string,unknown>,key:string):string{const value=optionalString(args,key);if(!value)throw new Error(`${key} is required`);return value}
function optionalString(args:Record<string,unknown>,key:string):string|undefined{const value=args[key];return typeof value==="string"&&value.trim()?value.trim():undefined}
function numberArg(args:Record<string,unknown>,key:string,fallback:number):number{return typeof args[key]==="number"?args[key]:fallback}
function optionalNumber(args:Record<string,unknown>,key:string):number|undefined{return typeof args[key]==="number"?args[key]:undefined}
function message(error:unknown):string{return error instanceof Error?error.message:String(error)}
