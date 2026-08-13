import { createHash, randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { chmod, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const LOOPBACK="127.0.0.1",MAX_DATAGRAM_BYTES=60*1024;
const relayDaemonScript=fileURLToPath(new URL("./event-relay-daemon.mjs",import.meta.url));

export function relayDirectory(env=process.env,home=homedir()){
  return env.HIPER_AGENT_MEMORY_BRIDGE_DIR?.trim()||resolve(home,".hiper-agent-memory","bridges");
}

export function configurationFingerprint(config){
  return createHash("sha256").update(`${config.gatewayUrl}\0${config.token}`).digest("hex");
}

export async function emitWriteEvent(config,event,options={}){
  const {matching}=await inspectEventRelays(config,options),target=matching[0];if(!target)return false;
  const payload=Buffer.from(JSON.stringify({nonce:target.nonce,event}));if(payload.byteLength>MAX_DATAGRAM_BYTES)return false;
  return new Promise(resolveResult=>{
    const socket=createSocket("udp4");let settled=false;
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);socket.close();resolveResult(value)};
    const timer=setTimeout(()=>finish(false),options.sendTimeoutMs??50);timer.unref();
    socket.once("error",()=>finish(false));socket.send(payload,target.port,LOOPBACK,error=>finish(!error));
  });
}

export async function ensureEventRelay(config,options={}){
  if((await inspectEventRelays(config,options)).matching.length)return true;
  try{const child=spawn(process.execPath,[relayDaemonScript],{detached:true,windowsHide:true,stdio:"ignore",env:{...process.env,...options.env,HIPER_AGENT_MEMORY_BRIDGE_DIR:options.directory||relayDirectory(options.env,options.home)}});child.unref()}catch{return false}
  const deadline=Date.now()+(options.startTimeoutMs??500);while(Date.now()<deadline){await new Promise(resolveWait=>setTimeout(resolveWait,20));if((await inspectEventRelays(config,options)).matching.length)return true}return false;
}

export async function inspectEventRelays(config,options={}){
  const directory=options.directory||relayDirectory(options.env,options.home),fingerprint=configurationFingerprint(config),matching=[];let staleRemoved=0;
  let names;try{names=await readdir(directory)}catch{return{matching,staleRemoved}}
  for(const name of names.filter(value=>value.endsWith(".json"))){
    const path=join(directory,name);
    try{
      const value=JSON.parse(await readFile(path,"utf8"));
      if(!validDescriptor(value)||!processAlive(value.pid)){await unlink(path).catch(()=>{});staleRemoved++;continue}
      if(value.configFingerprint===fingerprint)matching.push({...value,path});
    }catch{await unlink(path).catch(()=>{});staleRemoved++}
  }
  matching.sort((a,b)=>b.createdAt-a.createdAt);return{matching,staleRemoved};
}

export async function startEventRelay(config,options={}){
  const directory=options.directory||relayDirectory(options.env,options.home),nonce=randomBytes(24).toString("hex"),socket=createSocket("udp4");
  const maxEvents=options.maxEvents??256,maxBytes=options.maxBytes??2*1024*1024,maxBatchEvents=options.maxBatchEvents??32,maxBatchBytes=options.maxBatchBytes??480*1024,batchWindowMs=options.batchWindowMs??100;
  const queue=[];let queueBytes=0,flushing=false,flushPromise=null,timer=null,closed=false;
  const schedule=()=>{if(closed||flushing||timer||queue.length===0)return;timer=setTimeout(()=>{timer=null;void flush()},batchWindowMs);timer.unref()};
  const removeAt=index=>{const [removed]=queue.splice(index,1);if(removed)queueBytes-=removed.bytes};
  const enqueue=event=>{
    if(!validEvent(event))return;const bytes=Buffer.byteLength(JSON.stringify(event));if(bytes>maxBytes)return;
    while(queue.length>=maxEvents||queueBytes+bytes>maxBytes){const toolIndex=queue.findIndex(item=>item.event.type==="tool_use");if(toolIndex>=0)removeAt(toolIndex);else if(event.type==="tool_use")return;else removeAt(0)}
    queue.push({event,bytes});queueBytes+=bytes;options.onEvent?.(event);schedule();
  };
  const flush=()=>{
    if(closed||flushing||queue.length===0)return flushPromise||Promise.resolve();flushing=true;
    const selected=[];let selectedBytes=0;while(queue.length&&selected.length<maxBatchEvents){const next=queue[0];if(selected.length&&selectedBytes+next.bytes>maxBatchBytes)break;selected.push(queue.shift());selectedBytes+=next.bytes}queueBytes-=selectedBytes;
    flushPromise=(async()=>{try{
      const response=await (options.fetch||fetch)(`${config.gatewayUrl}/v1/hooks/batch`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${config.token}`},body:JSON.stringify({events:selected.map(item=>item.event)}),signal:AbortSignal.timeout(options.requestTimeoutMs??2000)});
      if(!response.ok)throw new Error(`gateway HTTP ${response.status}`);await response.arrayBuffer();
    }catch{/* best effort by design */}finally{flushing=false;flushPromise=null;schedule()}})();return flushPromise;
  };
  socket.on("message",message=>{try{const packet=JSON.parse(message.toString("utf8"));if(packet?.nonce===nonce)enqueue(packet.event)}catch{/* ignore malformed local datagrams */}});
  await new Promise((resolveBind,reject)=>{socket.once("error",reject);socket.bind(0,LOOPBACK,()=>{socket.off("error",reject);resolveBind()})});
  const address=socket.address(),descriptor={pid:process.pid,port:address.port,nonce,configFingerprint:configurationFingerprint(config),createdAt:Date.now()};
  await mkdir(directory,{recursive:true});const descriptorPath=join(directory,`${process.pid}-${nonce.slice(0,12)}.json`);await writeFile(descriptorPath,`${JSON.stringify(descriptor)}\n`,{encoding:"utf8",mode:0o600});if(process.platform!=="win32")await chmod(descriptorPath,0o600);
  const removeOnExit=()=>{try{unlinkSync(descriptorPath)}catch{}};process.once("exit",removeOnExit);
  return{
    port:address.port,descriptorPath,readDescriptor:async()=>JSON.parse(await readFile(descriptorPath,"utf8")),
    close:async()=>{if(closed)return;await new Promise(resolveGrace=>setTimeout(resolveGrace,options.shutdownGraceMs??50));if(timer){clearTimeout(timer);timer=null}if(flushPromise)await flushPromise;while(queue.length)await flush();closed=true;process.off("exit",removeOnExit);await new Promise(resolveClose=>socket.close(resolveClose));await unlink(descriptorPath).catch(()=>{})},
  };
}

function validDescriptor(value){return value&&Number.isInteger(value.pid)&&value.pid>0&&Number.isInteger(value.port)&&value.port>0&&value.port<65536&&typeof value.nonce==="string"&&value.nonce.length>=32&&typeof value.configFingerprint==="string"&&typeof value.createdAt==="number"}
function validEvent(value){return Boolean(value&&typeof value==="object"&&!Array.isArray(value)&&(value.type==="tool_use"||value.type==="stop"||value.type==="session_end")&&value.body&&typeof value.body==="object"&&!Array.isArray(value.body))}
function processAlive(pid){try{process.kill(pid,0);return true}catch(error){return error?.code==="EPERM"}}
