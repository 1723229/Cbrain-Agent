import { execFile } from "node:child_process";
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
const execFileAsync=promisify(execFile);
export function configPath(env=process.env,home=homedir()){return env.CBRAIN_AGENT_CONFIG?.trim()||resolve(home,".cbrain-agent","config.json")}
export function statePath(env=process.env,home=homedir()){return env.CBRAIN_AGENT_STATE?.trim()||resolve(home,".cbrain-agent","state.json")}

export async function loadGatewayConfig(options={}){
  const env=options.env||process.env;if(env.CBRAIN_AGENT_DISABLE==="1")return options.optional?null:(()=>{throw new Error("Cbrain Agent is disabled")})();const path=options.path||configPath(env,options.home);const file=await readJson(path);
  const gatewayUrl=normalizeGatewayUrl(env.CBRAIN_AGENT_GATEWAY_URL||file.gatewayUrl);
  const apiKey=clean(env.CBRAIN_AGENT_API_KEY||file.apiKey);
  if(!gatewayUrl||!apiKey){if(options.optional)return null;throw new Error("Cbrain Agent is not configured; run cbrain-agent-setup.mjs")}
  return{gatewayUrl,mcpUrl:`${gatewayUrl}/mcp`,apiKey,path};
}

export async function saveGatewayConfig({gatewayUrl,apiKey},options={}){
  const path=options.path||configPath(options.env,options.home);const value={gatewayUrl:normalizeGatewayUrl(gatewayUrl),apiKey:clean(apiKey)};
  if(!value.gatewayUrl||!value.apiKey)throw new Error("gateway URL and Cbrain API Key are required");await writePrivateJson(path,value,options);return path;
}

export async function readRuntimeState(options={}){const value=await readJson(options.path||statePath(options.env,options.home));return value&&typeof value==="object"?value:{}}
export async function writeRuntimeState(value,options={}){await writePrivateJson(options.path||statePath(options.env,options.home),value,options)}
export async function mutateRuntimeState(mutator,options={}){
  const path=options.path||statePath(options.env,options.home),lockPath=`${path}.lock`;await mkdir(dirname(path),{recursive:true});const lock=await acquireLock(lockPath,options);
  try{let state=pruneRuntimeState(await readRuntimeState({...options,path}));state=await mutator(state)||state;state=pruneRuntimeState(state);await writePrivateJson(path,state,{...options,skipAcl:true});return state}finally{await lock.close();await unlink(lockPath).catch(()=>{})}
}

export function normalizeGatewayUrl(value){const text=clean(value);if(!text)return"";const url=new URL(text);url.pathname=url.pathname.replace(/\/mcp\/?$/,"").replace(/\/+$/,"");url.search="";url.hash="";return url.toString().replace(/\/+$/,"")}
async function readJson(path){try{const value=JSON.parse(await readFile(path,"utf8"));return value&&typeof value==="object"?value:{}}catch(error){if(error?.code==="ENOENT")return{};throw new Error(`cannot read ${path}: ${error instanceof Error?error.message:String(error)}`)}}
async function writePrivateJson(path,value,options={}){await mkdir(dirname(path),{recursive:true});const temporary=`${path}.${process.pid}.${Date.now()}.tmp`;await writeFile(temporary,`${JSON.stringify(value,null,2)}\n`,{encoding:"utf8",mode:0o600});await rename(temporary,path);if((options.platform||process.platform)!=="win32")await chmod(path,0o600);else if(!options.skipAcl)await hardenWindowsAcl(path,options)}
async function acquireLock(path,options){const deadline=Date.now()+(options.lockTimeoutMs??2000);for(;;){try{return await open(path,"wx",0o600)}catch(error){if(error?.code!=="EEXIST")throw error;try{if(Date.now()-(await stat(path)).mtimeMs>10_000)await unlink(path)}catch{}if(Date.now()>=deadline)throw new Error(`timed out locking ${path}`);await new Promise((resolve)=>setTimeout(resolve,10+Math.floor(Math.random()*20)))}}}
function pruneRuntimeState(value){const cutoff=Date.now()-7*24*60*60_000;return Object.fromEntries(Object.entries(value&&typeof value==="object"?value:{}).filter(([,entry])=>!entry||typeof entry!=="object"||typeof entry.updatedAt!=="number"||entry.updatedAt>=cutoff))}
async function hardenWindowsAcl(path,options){const run=options.execFile||execFileAsync;const username=process.env.USERNAME;try{if(username)await run("icacls.exe",[path,"/inheritance:r","/grant:r",`${username}:(R,W)`],{windowsHide:true})}catch{/* best effort; parent user profile ACL still applies */}}
function clean(value){return typeof value==="string"?value.trim():""}
