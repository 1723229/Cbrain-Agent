#!/usr/bin/env node
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { loadGatewayConfig } from "./gateway-config.mjs";
import { configurationFingerprint, inspectEventRelays, relayDirectory, startEventRelay } from "./event-relay.mjs";

const config=await loadGatewayConfig({optional:true});if(!config)process.exit(0);
const directory=relayDirectory(),fingerprint=configurationFingerprint(config),lockPath=join(directory,`relay-${fingerprint}.lock`);await mkdir(directory,{recursive:true});
let lock;try{lock=await acquireStartupLock(lockPath,config,directory)}catch{process.exit(0)}
let relay,idleTimer,shuttingDown=false;
try{
  if((await inspectEventRelays(config,{directory})).matching.length)process.exit(0);
  const shutdown=async()=>{if(shuttingDown)return;shuttingDown=true;clearTimeout(idleTimer);await relay?.close();process.exit(0)};
  const resetIdle=()=>{clearTimeout(idleTimer);idleTimer=setTimeout(()=>void shutdown(),Number(process.env.HIPER_AGENT_MEMORY_RELAY_IDLE_MS)||5*60_000);idleTimer.unref()};
  relay=await startEventRelay(config,{directory,onEvent:resetIdle});resetIdle();
  await lock.close();lock=null;await unlink(lockPath).catch(()=>{});
  process.once("SIGTERM",()=>void shutdown());process.once("SIGINT",()=>void shutdown());
}catch{await relay?.close();process.exit(0)}finally{if(lock)await lock.close().catch(()=>{});await unlink(lockPath).catch(()=>{})}

async function acquireStartupLock(path,currentConfig,currentDirectory){
  try{return await open(path,"wx",0o600)}catch(error){if(error?.code!=="EEXIST")throw error}
  await new Promise(resolve=>setTimeout(resolve,200));if((await inspectEventRelays(currentConfig,{directory:currentDirectory})).matching.length)throw new Error("relay already started");
  try{if(Date.now()-(await stat(path)).mtimeMs<=5000)throw new Error("relay startup is in progress")}catch(error){if(error?.code!=="ENOENT")throw error}
  await unlink(path).catch(()=>{});return open(path,"wx",0o600);
}
