import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AgentBindingInvalidError, CoreDirectoryClient, UpstreamRequestError } from "./core-client.js";
import { GatewayStore } from "./gateway-store.js";
import { createMcpServer } from "./mcp-server.js";
import { GatewayAuthenticationError } from "./auth.js";
import type { AgentGatewayService } from "./service.js";
import type { GatewayPrincipal } from "./types.js";

export interface CreateAppOptions {
  authenticate: (authorization: string | undefined) => Promise<GatewayPrincipal>;
  store: GatewayStore; directory: CoreDirectoryClient;
  serviceFactory: (contextId: string, principal: GatewayPrincipal) => AgentGatewayService;
  contextTtlMs?: number;
  skillSettleMs?: number;
}

export function createAgentGatewayApp(options: CreateAppOptions): Hono {
  const app = new Hono();
  const authenticate = options.authenticate;
  const recordHookEvent = (principal:GatewayPrincipal,type:"tool_use"|"stop"|"session_end",body:Record<string,unknown>) => {
    const contextId=requiredField(body,"context_id");options.serviceFactory(contextId,principal);
    if(type==="tool_use"){
      const recorded=options.store.recordToolUse(contextId,turnId(body),requiredField(body,"tool_use_id"),requiredField(body,"tool_name"),body.tool_input,body.tool_response);
      options.store.touchSkillExtraction(contextId,options.skillSettleMs??5_000);return recorded;
    }
    if(type==="stop"){
      const queued=options.store.enqueueCapture(contextId,turnId(body),requiredField(body,"last_assistant_message"),optionalField(body,"prompt"));
      options.store.touchSkillExtraction(contextId,options.skillSettleMs??5_000);return queued;
    }
    return options.store.enqueueSkillExtraction(contextId,optionalField(body,"reason")||"session complete",options.skillSettleMs??5_000);
  };
  const openBoundWorkspace = async (principal: GatewayPrincipal, bindingRequestId: string, teamId: string, agentId: string) => {
    const checked = await options.directory.validate(principal, teamId, agentId);
    const completed = options.store.completeWorkspaceBinding(bindingRequestId, principal.id, checked.identity);
    const context = options.store.openContext(principal, checked.identity, {
      host: completed.request.host, sessionId: completed.request.sessionId, workspace: completed.request.workspace,
    }, options.contextTtlMs ?? 24 * 60 * 60_000);
    return {
      status: "bound" as const,
      workspace_key: completed.request.workspaceKey,
      workspace_label: completed.request.workspaceLabel,
      team_id: checked.identity.teamId,
      agent_id: checked.identity.agentId,
      agent_name: checked.identity.agentName,
      context_id: context.contextId,
      additionalContext: await renderSessionContext(options, context.contextId, principal),
    };
  };
  const workspaceStatus = async (principal:GatewayPrincipal,workspaceKey:string) => {
    const binding=options.store.getWorkspaceBinding(principal.id,bounded(workspaceKey,"workspace_key",256));
    return binding?{status:"bound" as const,workspace_key:binding.workspaceKey,workspace_label:binding.workspaceLabel,team_id:binding.teamId,agent_id:binding.agentId,agent_name:binding.agentName}:{status:"unbound" as const,workspace_key:workspaceKey};
  };
  const beginWorkspaceSelection = async (principal:GatewayPrincipal,input:{workspaceKey:string;workspaceLabel:string;host:string;sessionId:string;workspace:string},rebind=false) => {
    const safe={workspaceKey:bounded(input.workspaceKey,"workspace_key",256),workspaceLabel:bounded(input.workspaceLabel,"workspace_label",256),host:bounded(input.host,"host",64),sessionId:bounded(input.sessionId,"session_id",512),workspace:bounded(input.workspace,"workspace",4096)};
    const current=options.store.getWorkspaceBinding(principal.id,safe.workspaceKey);
    const request=options.store.issueWorkspaceBindingRequest(principal.id,safe,10*60_000);
    const directory=await options.directory.options(principal) as {teams?:unknown[];agents?:unknown[]};
    return {status:rebind?"selection_required" as const:"unbound" as const,binding_request_id:request.requestId,binding_expires_at:request.expiresAt,workspace_key:safe.workspaceKey,workspace_label:safe.workspaceLabel,...(current?{current_binding:{team_id:current.teamId,agent_id:current.agentId,agent_name:current.agentName}}:{}),teams:directory.teams??[],agents:directory.agents??[]};
  };
  const unbindWorkspace = async (principal:GatewayPrincipal,workspaceKey:string) => {
    const key=bounded(workspaceKey,"workspace_key",256);return{status:"unbound" as const,removed:options.store.removeWorkspaceBinding(principal.id,key),workspace_key:key};
  };
  app.onError((error,c)=>{console.error(`[gateway] request rejected: ${message(error)}`);const status=error instanceof GatewayAuthenticationError?401:error instanceof HttpError?error.status:error instanceof UpstreamRequestError?(error.retryable?503:502):400;return c.json({error:message(error)},status as 400|401|502|503)});
  app.get("/health",(c)=>c.json({status:"ok",service:"cbrain-agent-gateway"}));
  app.get("/health/live",(c)=>c.json({status:"ok"}));
  app.get("/health/ready",(c)=>c.json({
    status:"ok",
    pending_captures:options.store.pendingCaptureCount(),
    pending_skill_extractions:options.store.pendingSkillExtractionCount(),
    dead_captures:options.store.deadCaptureCount(),
    dead_skill_extractions:options.store.deadSkillExtractionCount(),
    oldest_pending_age_ms:options.store.oldestPendingAgeMs(),
  }));
  app.get("/v1/auth/me",async(c)=>{const principal=await authenticate(c.req.header("authorization"));return c.json({principal_id:principal.id,user_id:principal.userId})});
  app.post("/v1/bindings/options",async(c)=>c.json(await options.directory.options(await authenticate(c.req.header("authorization")))));
  app.post("/v1/workspaces/resolve",async(c)=>{
    const principal=await authenticate(c.req.header("authorization"));const body=await jsonBody(c.req.raw);
    const workspaceKey=requiredBoundedField(body,"workspace_key",256);
    const workspaceLabel=requiredBoundedField(body,"workspace_label",256);
    const host=requiredBoundedField(body,"host",64);const sessionId=requiredBoundedField(body,"session_id",512);
    const workspace=requiredBoundedField(body,"workspace",4096);
    const binding=options.store.getWorkspaceBinding(principal.id,workspaceKey);
    if(binding){
      try{
        const checked=await options.directory.validate(principal,binding.teamId,binding.agentId);
        const context=options.store.openContext(principal,checked.identity,{host,sessionId,workspace},options.contextTtlMs??24*60*60_000);
        return c.json({status:"bound",workspace_key:workspaceKey,workspace_label:workspaceLabel,team_id:checked.identity.teamId,agent_id:checked.identity.agentId,agent_name:checked.identity.agentName,context_id:context.contextId,additionalContext:await renderSessionContext(options,context.contextId,principal)});
      }catch(error){
        if(error instanceof AgentBindingInvalidError){console.error(`[gateway] removing stale workspace binding: ${message(error)}`);options.store.removeWorkspaceBinding(principal.id,workspaceKey)}
        else throw new HttpError("agent directory is temporarily unavailable",503);
      }
    }
    return c.json(await beginWorkspaceSelection(principal,{workspaceKey,workspaceLabel,host,sessionId,workspace}));
  });
  app.post("/v1/workspaces/bind",async(c)=>{
    const principal=await authenticate(c.req.header("authorization"));const body=await jsonBody(c.req.raw);
    return c.json(await openBoundWorkspace(principal,requiredField(body,"binding_request_id"),requiredField(body,"team_id"),requiredField(body,"agent_id")));
  });
  app.post("/v1/workspaces/status",async(c)=>{const principal=await authenticate(c.req.header("authorization")),body=await jsonBody(c.req.raw);return c.json(await workspaceStatus(principal,requiredField(body,"workspace_key")))});
  app.post("/v1/workspaces/rebind",async(c)=>{const principal=await authenticate(c.req.header("authorization")),body=await jsonBody(c.req.raw);return c.json(await beginWorkspaceSelection(principal,{workspaceKey:requiredField(body,"workspace_key"),workspaceLabel:requiredField(body,"workspace_label"),host:requiredField(body,"host"),sessionId:requiredField(body,"session_id"),workspace:requiredField(body,"workspace")},true))});
  app.post("/v1/workspaces/unbind",async(c)=>{const principal=await authenticate(c.req.header("authorization")),body=await jsonBody(c.req.raw);return c.json(await unbindWorkspace(principal,requiredField(body,"workspace_key")))});
  app.post("/v1/sessions/open",async(c)=>{
    const principal=await authenticate(c.req.header("authorization"));const body=await jsonBody(c.req.raw);
    const teamId=optionalField(body,"team_id");const agentId=optionalField(body,"agent_id");
    if(!teamId||!agentId)throw new Error("team_id and agent_id are required");
    const checked=await options.directory.validate(principal,teamId,agentId);
    const context=options.store.openContext(principal,checked.identity,{host:requiredField(body,"host"),sessionId:requiredField(body,"session_id"),workspace:requiredField(body,"workspace")},options.contextTtlMs??24*60*60_000);
    const additionalContext=await renderSessionContext(options,context.contextId,principal);
    return c.json({context_id:context.contextId,additionalContext});
  });
  app.post("/v1/hooks/prompt",async(c)=>{
    const principal=await authenticate(c.req.header("authorization"));const body=await jsonBody(c.req.raw);const contextId=requiredField(body,"context_id");
    const service=options.serviceFactory(contextId,principal);const prompt=requiredField(body,"prompt");options.store.beginTurn(contextId,turnId(body),prompt);
    try{return c.json({additionalContext:await service.renderRecallContext(prompt)})}catch(error){console.error(`[gateway] prompt recall degraded: ${message(error)}`);return c.json({additionalContext:""})}
  });
  app.post("/v1/hooks/stop",async(c)=>{
    const principal=await authenticate(c.req.header("authorization"));const body=await jsonBody(c.req.raw);const queued=recordHookEvent(principal,"stop",body);
    return c.json({accepted:queued.duplicate?0:1,duplicate:queued.duplicate,pending:options.store.pendingCaptureCount()},202);
  });
  app.post("/v1/hooks/tool-use",async(c)=>{
    const principal=await authenticate(c.req.header("authorization"));const body=await jsonBody(c.req.raw);const recorded=recordHookEvent(principal,"tool_use",body);
    return c.json({accepted:recorded.duplicate?0:1,duplicate:recorded.duplicate});
  });
  app.post("/v1/hooks/session-end",async(c)=>{
    const principal=await authenticate(c.req.header("authorization"));const body=await jsonBody(c.req.raw);const queued=recordHookEvent(principal,"session_end",body);
    return c.json({accepted:queued.duplicate?0:1,duplicate:queued.duplicate,pending:options.store.pendingSkillExtractionCount()},202);
  });
  app.post("/v1/hooks/batch",async(c)=>{
    const principal=await authenticate(c.req.header("authorization"));const body=await jsonBody(c.req.raw,512*1024);const events=body.events;
    if(!Array.isArray(events)||events.length<1||events.length>32)throw new Error("events must contain between 1 and 32 items");
    let accepted=0,duplicates=0,rejected=0;
    for(const event of events){
      try{
        if(!event||typeof event!=="object"||Array.isArray(event))throw new Error("event must be an object");
        const value=event as Record<string,unknown>,type=value.type;
        if(type!=="tool_use"&&type!=="stop"&&type!=="session_end")throw new Error("unsupported hook event type");
        if(!value.body||typeof value.body!=="object"||Array.isArray(value.body))throw new Error("event body must be an object");
        const result=recordHookEvent(principal,type,value.body as Record<string,unknown>);if(result.duplicate)duplicates++;else accepted++;
      }catch{rejected++}
    }
    return c.json({accepted,duplicates,rejected},202);
  });
  app.all("/mcp",async(c)=>{
    const principal=await authenticate(c.req.header("authorization"));
    const transport=new WebStandardStreamableHTTPServerTransport({enableJsonResponse:true});
    const server=createMcpServer((contextId)=>options.serviceFactory(contextId,principal),{
      bind:(input)=>openBoundWorkspace(principal,input.bindingRequestId,input.teamId,input.agentId),
      status:(workspaceKey)=>workspaceStatus(principal,workspaceKey),
      rebind:(input)=>beginWorkspaceSelection(principal,input,true),
      unbind:(workspaceKey)=>unbindWorkspace(principal,workspaceKey),
    });await server.connect(transport);return transport.handleRequest(c.req.raw);
  });
  return app;
}

class HttpError extends Error{constructor(message:string,readonly status:400|401|502|503){super(message)}}
async function jsonBody(request:Request,maxBytes?:number):Promise<Record<string,unknown>>{
  if(maxBytes){const declared=Number(request.headers.get("content-length"));if(Number.isFinite(declared)&&declared>maxBytes)throw new Error("request body is too large")}
  const text=await request.text();if(maxBytes&&new TextEncoder().encode(text).byteLength>maxBytes)throw new Error("request body is too large");
  let body:unknown;try{body=JSON.parse(text)}catch{body=null}if(!body||typeof body!=="object"||Array.isArray(body))throw new Error("JSON object body is required");return body as Record<string,unknown>;
}
function optionalField(body:Record<string,unknown>,key:string):string|undefined{const value=body[key];return typeof value==="string"&&value.trim()?value.trim():undefined}
function requiredField(body:Record<string,unknown>,key:string):string{const value=optionalField(body,key);if(!value)throw new Error(`${key} is required`);return value}
function requiredBoundedField(body:Record<string,unknown>,key:string,maxLength:number):string{const value=requiredField(body,key);if(value.length>maxLength)throw new Error(`${key} is too long`);return value}
function bounded(value:string,key:string,maxLength:number):string{const result=value.trim();if(!result)throw new Error(`${key} is required`);if(result.length>maxLength)throw new Error(`${key} is too long`);return result}
function turnId(body:Record<string,unknown>):string{return optionalField(body,"turn_id")||"current"}
function message(error:unknown):string{return error instanceof Error?error.message:String(error)}
async function renderSessionContext(options:CreateAppOptions,contextId:string,principal:GatewayPrincipal):Promise<string>{return options.serviceFactory(contextId,principal).renderSessionContext(contextId).catch((error)=>{console.error(`[gateway] session context degraded: ${message(error)}`);return `<cbrain_agent_context>\n${JSON.stringify({context_id:contextId,instructions:"Every cbrain-agent MCP tool call must include this context_id."})}\n</cbrain_agent_context>`})}
