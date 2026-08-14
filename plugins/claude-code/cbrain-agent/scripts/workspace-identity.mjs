import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync=promisify(execFile);

export async function workspaceIdentity(cwd,options={}){
  const env=options.env||process.env;
  const explicit=clean(env.CBRAIN_AGENT_WORKSPACE_KEY);
  const root=await gitValue(cwd,["rev-parse","--show-toplevel"],options)||resolve(cwd);
  const label=clean(env.CBRAIN_AGENT_WORKSPACE_LABEL)||await configuredLabel(root,options)||basename(root)||root;
  if(explicit)return{key:explicit,label,root};
  const remote=normalizeRemote(await gitValue(root,["config","--get","remote.origin.url"],options));
  if(remote)return{key:`git:${digest(remote)}`,label,root};
  return{key:`path:${digest(portablePathKey(root,options.platform||process.platform))}`,label,root};
}

async function configuredLabel(root,options){
  const read=options.readFile||readFile;
  try{
    const config=JSON.parse(await read(resolve(root,".cbrain.json"),"utf8"));
    return clean(config?.workspaceLabel);
  }catch{return""}
}

export function normalizeRemote(value){
  const source=clean(value);if(!source)return"";
  let host="",repository="";
  const scp=!source.includes("://")?source.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/):null;
  if(scp&&!/^[A-Za-z]:[\\/]/.test(source)){host=scp[1];repository=scp[2]}
  else try{const url=new URL(source);host=url.hostname;repository=url.pathname}catch{return""}
  repository=repository.replace(/^\/+|\/+$/g,"").replace(/\.git$/i,"");
  return host&&repository?`${host.toLowerCase()}/${repository.toLowerCase()}`:"";
}

export function portablePathKey(value,platform=process.platform){
  let result=String(value||"").replace(/\\/g,"/").replace(/\/+$/g,"");
  const wsl=result.match(/^\/mnt\/([a-z])(?:\/(.*))?$/i);
  if(wsl)result=`${wsl[1]}:/${wsl[2]||""}`;
  if(platform==="win32"||/^[a-z]:\//i.test(result))result=result.toLowerCase();
  return result;
}

async function gitValue(cwd,args,options){
  const run=options.execFile||execFileAsync;
  try{const{stdout}=await run("git",["-C",cwd,...args],{encoding:"utf8",windowsHide:true,timeout:1500});return clean(stdout)}catch{return""}
}
function digest(value){return createHash("sha256").update(value).digest("hex")}
function clean(value){return typeof value==="string"?value.trim():""}
