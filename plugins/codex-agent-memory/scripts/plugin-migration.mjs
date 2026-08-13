import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync=promisify(execFile),LEGACY_MARKER="tdai-memory-local";

export async function legacyPluginDetected(options={}){
  const codexHome=options.env?.CODEX_HOME||process.env.CODEX_HOME||resolve(options.home||homedir(),".codex"),path=options.configPath||resolve(codexHome,"config.toml");
  try{const content=await readFile(path,"utf8");return /^\[marketplaces\.tdai-memory-local\]\s*$/m.test(content)}catch{return false}
}

export async function migrateLegacyPlugin(options={}){
  if(!await legacyPluginDetected(options))return{detected:false,removed:false,warnings:[]};
  const run=options.run||runCodex,warnings=[];let pluginRemoved=false,marketplaceRemoved=false;
  try{await run(["plugin","remove","codex-agent-memory@tdai-memory-local","--json"],options);pluginRemoved=true}catch(error){warnings.push(`legacy plugin removal: ${message(error)}`)}
  try{await run(["plugin","marketplace","remove",LEGACY_MARKER,"--json"],options);marketplaceRemoved=true}catch(error){warnings.push(`legacy marketplace removal: ${message(error)}`)}
  return{detected:true,removed:pluginRemoved&&marketplaceRemoved,warnings};
}

async function runCodex(args,options={}){
  const platform=options.platform||process.platform;
  if(platform==="win32")return execFileAsync("cmd.exe",["/d","/s","/c","codex",...args],{encoding:"utf8",windowsHide:true});
  return execFileAsync("codex",args,{encoding:"utf8"});
}
function message(error){return error instanceof Error?error.message:String(error)}
