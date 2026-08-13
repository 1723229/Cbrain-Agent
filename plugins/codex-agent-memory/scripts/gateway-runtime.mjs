import { loadGatewayConfig, mutateRuntimeState, readRuntimeState } from "./gateway-config.mjs";
import { emitWriteEvent } from "./event-relay.mjs";
import { workspaceIdentity } from "./workspace-identity.mjs";

export async function runtimeFor(input,host="codex"){
  const config=await loadGatewayConfig({optional:true});if(!config)return null;const cwd=text(input.cwd);if(!cwd)return null;
  const sessionId=text(input.session_id)||text(input.conversation_id);if(!sessionId)return null;const key=`${host}:${sessionId}:${cwd}`,state=await readRuntimeState();return{config,cwd,sessionId,key,state,entry:state[key]||null,workspaceIdentity:null};
}
export async function ensureSession(runtime,host="codex"){if(runtime.entry?.contextId)return runtime.entry;const result=await resolveWorkspace(runtime,host);if(result.status!=="bound"||!runtime.entry?.contextId)throw new Error("workspace is not bound");return runtime.entry}
export async function resolveWorkspace(runtime,host="codex"){
  await ensureWorkspaceIdentity(runtime);
  if(circuitOpen(runtime,"resolve"))return{status:"degraded"};
  let result;try{result=await post(runtime.config,"/v1/workspaces/resolve",{workspace_key:runtime.workspaceIdentity.key,workspace_label:runtime.workspaceIdentity.label,host,session_id:runtime.sessionId,workspace:runtime.cwd},2500);await clearCircuit(runtime,"resolve")}catch(error){await markCircuitFailure(runtime,"resolve");throw error}
  if(result.status==="bound")return acceptWorkspaceBinding(runtime,result);
  runtime.entry={...runtime.entry,bindingRequestId:result.binding_request_id,bindingExpiresAt:Number(result.binding_expires_at)||Date.now()+9*60_000,bindingOptions:{teams:Array.isArray(result.teams)?result.teams:[],agents:Array.isArray(result.agents)?result.agents:[]},workspaceKey:runtime.workspaceIdentity.key,workspaceLabel:runtime.workspaceIdentity.label,updatedAt:Date.now()};await persistEntry(runtime);return result;
}
export async function acceptWorkspaceBinding(runtime,result){
  await ensureWorkspaceIdentity(runtime);const profile=text(result.agent_name)||text(result.agent_id);
  runtime.entry={...runtime.entry,contextId:text(result.context_id),profile,teamId:text(result.team_id),agentId:text(result.agent_id),prompt:runtime.entry?.pendingOriginalPrompt||runtime.entry?.prompt,pendingOriginalPrompt:undefined,bindingRequestId:undefined,bindingExpiresAt:undefined,bindingOptions:undefined,workspaceKey:runtime.workspaceIdentity.key,workspaceLabel:runtime.workspaceIdentity.label,updatedAt:Date.now()};await persistEntry(runtime);return result;
}
export async function rememberPrompt(runtime,prompt,turnId){runtime.entry={...runtime.entry,prompt,turnId,updatedAt:Date.now()};await persistEntry(runtime)}
export async function rememberBindingPrompt(runtime,prompt,turnId){runtime.entry={...runtime.entry,pendingOriginalPrompt:runtime.entry?.pendingOriginalPrompt||prompt,turnId,updatedAt:Date.now()};await persistEntry(runtime)}
export async function clearWorkspaceSession(runtime){runtime.state=await mutateRuntimeState((state)=>{delete state[runtime.key];return state});runtime.entry=null}
export function circuitOpen(runtime,name){return Number(runtime.entry?.[`${name}CircuitUntil`])>Date.now()}
export async function markCircuitFailure(runtime,name,durationMs=30_000){runtime.entry={...runtime.entry,[`${name}CircuitUntil`]:Date.now()+durationMs,updatedAt:Date.now()};await persistEntry(runtime)}
export async function clearCircuit(runtime,name){const key=`${name}CircuitUntil`;if(!runtime.entry||!(key in runtime.entry))return;const entry={...runtime.entry};delete entry[key];runtime.entry={...entry,updatedAt:Date.now()};await persistEntry(runtime)}
export async function postAsync(config,path,body){
  const type=path==="/v1/hooks/tool-use"?"tool_use":path==="/v1/hooks/stop"?"stop":path==="/v1/hooks/session-end"?"session_end":"";
  return type?emitWriteEvent(config,{type,body:compactBody(body)}):false;
}
export async function post(config,path,body,timeoutMs=9000){const response=await fetch(`${config.gatewayUrl}${path}`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${config.token}`},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});if(!response.ok)throw new Error(`gateway HTTP ${response.status}`);return response.json()}
export function text(value){return typeof value==="string"&&value.trim()?value.trim():""}
export async function ensureWorkspaceIdentity(runtime){if(!runtime.workspaceIdentity)runtime.workspaceIdentity=await workspaceIdentity(runtime.cwd);return runtime.workspaceIdentity}
export function pendingWorkspaceBinding(runtime){const entry=runtime.entry;if(!entry?.bindingRequestId||!entry.bindingOptions||Number(entry.bindingExpiresAt)<=Date.now())return null;return{status:"unbound",binding_request_id:entry.bindingRequestId,binding_expires_at:entry.bindingExpiresAt,teams:entry.bindingOptions.teams||[],agents:entry.bindingOptions.agents||[]}}
async function persistEntry(runtime){const entry=runtime.entry;runtime.state=await mutateRuntimeState((state)=>{if(entry)state[runtime.key]=entry;else delete state[runtime.key];return state})}
function compactBody(body){const result={...body};for(const key of ["prompt","last_assistant_message"]){if(typeof result[key]==="string")result[key]=boundedText(result[key],6000)}for(const key of ["tool_input","tool_response"]){if(key in result)result[key]=boundedValue(result[key],6000)}return result}
function boundedValue(value,max){const json=JSON.stringify(value);return !json||json.length<=max?value:{truncated:true,preview:boundedText(json,max)}}
function boundedText(value,max){if(value.length<=max)return value;const half=Math.floor((max-32)/2);return`${value.slice(0,half)}\n...[client truncated]...\n${value.slice(-half)}`}
