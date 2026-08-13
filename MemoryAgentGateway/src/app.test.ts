import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAgentGatewayApp } from "./app.js";
import { GatewayStore } from "./gateway-store.js";
import type { AgentGatewayService } from "./service.js";

const principal={id:"user-1",token:"secret",userId:"usr-1",userKey:"uk-test"};
function fixture(){
  const store=new GatewayStore(join(mkdtempSync(join(tmpdir(),"gateway-test-")),"gateway.sqlite"));
  const service={renderSessionContext:vi.fn(async()=>"profile"),renderRecallContext:vi.fn(async()=>"recall")} as unknown as AgentGatewayService;
  const directory={options:vi.fn(async()=>({teams:[{team_id:"team-1",name:"Team One"}],agents:[{agent_id:"agent-1",team_id:"team-1",name:"Agent"}]})),validate:vi.fn(async()=>({identity:{teamId:"team-1",userId:"usr-1",userKey:"uk-test",agentId:"agent-1",agentName:"Agent"},agent:{}}))};
  const app=createAgentGatewayApp({principals:[principal],store,directory:directory as never,serviceFactory:()=>service});
  return{app,store,service,directory};
}
const headers={"Content-Type":"application/json",Authorization:"Bearer secret"};
describe("agent gateway lifecycle",()=>{
  it("rejects unauthenticated requests",async()=>{const{app}=fixture();expect((await app.request("http://localhost/v1/bindings/options",{method:"POST"})).status).toBe(401)});
  it("reports the authenticated identity without exposing its credential",async()=>{const{app}=fixture();const response=await app.request("http://localhost/v1/auth/me",{headers});expect(response.status).toBe(200);expect(await response.json()).toEqual({principal_id:"user-1",user_id:"usr-1"})});
  it("opens a validated context, recalls, and durably deduplicates capture",async()=>{
    const{app,store,directory}=fixture();
    const opened=await app.request("http://localhost/v1/sessions/open",{method:"POST",headers,body:JSON.stringify({host:"codex",session_id:"s1",workspace:"C:/repo",team_id:"team-1",agent_id:"agent-1"})});
    expect(opened.status).toBe(200);const openBody=await opened.json() as {context_id:string;additionalContext:string};expect(openBody.additionalContext).toBe("profile");expect(directory.validate).toHaveBeenCalledWith(principal,"team-1","agent-1");
    const prompt={context_id:openBody.context_id,turn_id:"t1",prompt:"remember this"};
    expect(await(await app.request("http://localhost/v1/hooks/prompt",{method:"POST",headers,body:JSON.stringify(prompt)})).json()).toMatchObject({additionalContext:"recall"});
    const stop={context_id:openBody.context_id,turn_id:"t1",prompt:"remember this",last_assistant_message:"done"};
    const accepted=await app.request("http://localhost/v1/hooks/stop",{method:"POST",headers,body:JSON.stringify(stop)});expect(accepted.status).toBe(202);expect(await accepted.json()).toMatchObject({accepted:1,duplicate:false});
    expect(await(await app.request("http://localhost/v1/hooks/stop",{method:"POST",headers,body:JSON.stringify(stop)})).json()).toMatchObject({accepted:0,duplicate:true});
    expect(store.pendingCaptureCount()).toBe(1);
  });
  it("records tool output and queues direct extraction when the Codex session ends",async()=>{
    const{app,store}=fixture();
    const opened=await app.request("http://localhost/v1/sessions/open",{method:"POST",headers,body:JSON.stringify({host:"codex",session_id:"s2",workspace:"C:/repo",team_id:"team-1",agent_id:"agent-1"})});
    const {context_id}=await opened.json() as {context_id:string};
    await app.request("http://localhost/v1/hooks/prompt",{method:"POST",headers,body:JSON.stringify({context_id,turn_id:"t2",prompt:"build it"})});
    const tool=await app.request("http://localhost/v1/hooks/tool-use",{method:"POST",headers,body:JSON.stringify({context_id,turn_id:"t2",tool_use_id:"tool-1",tool_name:"apply_patch",tool_input:{patch:"change"},tool_response:{ok:true}})});
    expect(tool.status).toBe(200);
    await app.request("http://localhost/v1/hooks/stop",{method:"POST",headers,body:JSON.stringify({context_id,turn_id:"t2",last_assistant_message:"done"})});
    const ended=await app.request("http://localhost/v1/hooks/session-end",{method:"POST",headers,body:JSON.stringify({context_id,reason:"other"})});
    expect(ended.status).toBe(202);expect(await ended.json()).toMatchObject({accepted:1,duplicate:false});
    expect(store.pendingSkillExtractionCount()).toBe(1);
  });
  it("accepts an ordered hook batch and isolates invalid or duplicate events",async()=>{
    const{app,store}=fixture();
    const opened=await app.request("http://localhost/v1/sessions/open",{method:"POST",headers,body:JSON.stringify({host:"codex",session_id:"batch-session",workspace:"C:/repo",team_id:"team-1",agent_id:"agent-1"})});
    const {context_id}=await opened.json() as {context_id:string};
    await app.request("http://localhost/v1/hooks/prompt",{method:"POST",headers,body:JSON.stringify({context_id,turn_id:"batch-turn",prompt:"build it"})});
    const tool={type:"tool_use",body:{context_id,turn_id:"batch-turn",tool_use_id:"tool-batch-1",tool_name:"apply_patch",tool_input:{patch:"change"},tool_response:{ok:true}}};
    const response=await app.request("http://localhost/v1/hooks/batch",{method:"POST",headers,body:JSON.stringify({events:[tool,tool,{type:"unknown",body:{}},{type:"stop",body:{context_id,turn_id:"batch-turn",last_assistant_message:"done"}},{type:"session_end",body:{context_id,reason:"other"}}]})});
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({accepted:3,duplicates:1,rejected:1});
    expect(store.pendingCaptureCount()).toBe(1);
    expect(store.pendingSkillExtractionCount()).toBe(1);
  });
  it("rejects oversized or over-count hook batches before processing",async()=>{
    const{app}=fixture();
    const tooMany=await app.request("http://localhost/v1/hooks/batch",{method:"POST",headers,body:JSON.stringify({events:Array.from({length:33},()=>({type:"unknown",body:{}}))})});
    expect(tooMany.status).toBe(400);
    const oversized=await app.request("http://localhost/v1/hooks/batch",{method:"POST",headers,body:JSON.stringify({events:[{type:"unknown",body:{payload:"x".repeat(513*1024)}}]})});
    expect(oversized.status).toBe(400);
  });
  it("resolves and completes a central workspace binding before opening memory",async()=>{
    const{app,directory}=fixture();
    const resolveBody={workspace_key:"git:abc",workspace_label:"repo",host:"codex",session_id:"s3",workspace:"C:/repo"};
    const first=await app.request("http://localhost/v1/workspaces/resolve",{method:"POST",headers,body:JSON.stringify(resolveBody)});
    expect(first.status).toBe(200);const unbound=await first.json() as {status:string;binding_request_id:string;teams:unknown[];agents:unknown[]};
    expect(unbound).toMatchObject({status:"unbound"});expect(unbound.teams).toHaveLength(1);expect(unbound.agents).toHaveLength(1);
    const boundResponse=await app.request("http://localhost/v1/workspaces/bind",{method:"POST",headers,body:JSON.stringify({binding_request_id:unbound.binding_request_id,team_id:"team-1",agent_id:"agent-1"})});
    expect(boundResponse.status).toBe(200);expect(await boundResponse.json()).toMatchObject({status:"bound",team_id:"team-1",agent_id:"agent-1",additionalContext:"profile"});
    expect(directory.validate).toHaveBeenCalledWith(principal,"team-1","agent-1");
    const second=await app.request("http://localhost/v1/workspaces/resolve",{method:"POST",headers,body:JSON.stringify({...resolveBody,session_id:"s4"})});
    expect(await second.json()).toMatchObject({status:"bound",team_id:"team-1",agent_id:"agent-1"});
    expect(await(await app.request("http://localhost/v1/workspaces/status",{method:"POST",headers,body:JSON.stringify({workspace_key:"git:abc"})})).json()).toMatchObject({status:"bound",team_id:"team-1",agent_id:"agent-1"});
    const rebind=await app.request("http://localhost/v1/workspaces/rebind",{method:"POST",headers,body:JSON.stringify({...resolveBody,session_id:"s5"})});
    const reselection=await rebind.json() as {binding_request_id:string};expect(reselection).toMatchObject({status:"selection_required",current_binding:{team_id:"team-1",agent_id:"agent-1"},teams:[{team_id:"team-1"}]});
    const removed=await app.request("http://localhost/v1/workspaces/unbind",{method:"POST",headers,body:JSON.stringify({workspace_key:"git:abc"})});
    expect(await removed.json()).toEqual({status:"unbound",removed:true,workspace_key:"git:abc"});
    expect((await app.request("http://localhost/v1/workspaces/bind",{method:"POST",headers,body:JSON.stringify({binding_request_id:reselection.binding_request_id,team_id:"team-1",agent_id:"agent-1"})})).status).toBe(400);
    expect(await(await app.request("http://localhost/v1/workspaces/status",{method:"POST",headers,body:JSON.stringify({workspace_key:"git:abc"})})).json()).toEqual({status:"unbound",workspace_key:"git:abc"});
  });
  it("preserves a binding when directory validation is temporarily unavailable",async()=>{
    const{app,store,directory}=fixture();const request=store.issueWorkspaceBindingRequest(principal.id,{workspaceKey:"git:transient",workspaceLabel:"repo",host:"codex",sessionId:"old",workspace:"C:/repo"},60_000);store.completeWorkspaceBinding(request.requestId,principal.id,{teamId:"team-1",userId:principal.userId,agentId:"agent-1"});directory.validate.mockRejectedValueOnce(new Error("upstream timeout"));const response=await app.request("http://localhost/v1/workspaces/resolve",{method:"POST",headers,body:JSON.stringify({workspace_key:"git:transient",workspace_label:"repo",host:"codex",session_id:"new",workspace:"C:/repo"})});expect(response.status).toBe(503);expect(store.getWorkspaceBinding(principal.id,"git:transient")).not.toBeNull();
  });
});
