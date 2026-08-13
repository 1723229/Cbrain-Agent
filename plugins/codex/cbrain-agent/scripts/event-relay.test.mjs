import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configurationFingerprint, emitWriteEvent, ensureEventRelay, inspectEventRelays, startEventRelay } from "./event-relay.mjs";

const config={gatewayUrl:"http://gateway.invalid",apiKey:"secret"};

test("a hook datagram is batched by the matching relay without exposing the API Key",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"hiper-relay-")),requests=[];
  const relay=await startEventRelay(config,{directory,batchWindowMs:20,fetch:async(url,init)=>{requests.push({url,body:JSON.parse(init.body)});return new Response(null,{status:202})}});
  try{
    assert.equal(await emitWriteEvent(config,{type:"tool_use",body:{context_id:"ctx",tool_use_id:"one"}},{directory}),true);
    assert.equal(await emitWriteEvent({...config,apiKey:"other"},{type:"tool_use",body:{context_id:"wrong"}},{directory}),false);
    await waitFor(()=>requests.length===1);
    assert.equal(requests[0].url,"http://gateway.invalid/v1/hooks/batch");
    assert.deepEqual(requests[0].body.events,[{type:"tool_use",body:{context_id:"ctx",tool_use_id:"one"}}]);
    const descriptor=await relay.readDescriptor();
    assert.equal(JSON.stringify(descriptor).includes("secret"),false);
  }finally{await relay.close();await rm(directory,{recursive:true,force:true})}
});

test("relay bounds the queue and preserves stop and session-end events",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"hiper-relay-priority-")),batches=[];
  let release;const blocked=new Promise(resolve=>release=resolve);
  const relay=await startEventRelay(config,{directory,batchWindowMs:5,maxEvents:3,maxBatchEvents:3,fetch:async(_url,init)=>{batches.push(JSON.parse(init.body));await blocked;return new Response(null,{status:202})}});
  try{
    await emitWriteEvent(config,{type:"tool_use",body:{tool_use_id:"one"}},{directory});
    await waitFor(()=>batches.length===1);
    for(const event of [
      {type:"tool_use",body:{tool_use_id:"two"}},
      {type:"tool_use",body:{tool_use_id:"three"}},
      {type:"tool_use",body:{tool_use_id:"four"}},
      {type:"stop",body:{turn_id:"turn"}},
      {type:"session_end",body:{reason:"other"}},
    ])await emitWriteEvent(config,event,{directory});
    release();await waitFor(()=>batches.length===2);
    assert.deepEqual(batches[1].events.map(event=>event.type),["tool_use","stop","session_end"]);
    assert.equal(batches[1].events[0].body.tool_use_id,"four");
  }finally{release?.();await relay.close();await rm(directory,{recursive:true,force:true})}
});

test("twenty concurrent hook events are coalesced into one bounded request",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"hiper-relay-burst-")),batches=[];
  const relay=await startEventRelay(config,{directory,batchWindowMs:40,fetch:async(_url,init)=>{batches.push(JSON.parse(init.body));return new Response(null,{status:202})}});
  try{
    await Promise.all(Array.from({length:20},(_,index)=>emitWriteEvent(config,{type:"tool_use",body:{tool_use_id:`tool-${index}`}},{directory})));
    await waitFor(()=>batches.length===1);assert.equal(batches[0].events.length,20);
  }finally{await relay.close();await rm(directory,{recursive:true,force:true})}
});

test("closing a relay removes its discoverable descriptor",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"hiper-relay-close-"));const relay=await startEventRelay(config,{directory});
  await relay.close();assert.deepEqual(await readdir(directory),[]);await rm(directory,{recursive:true,force:true});
});

test("closing a relay drains the final in-memory batch",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"hiper-relay-drain-")),batches=[];
  const relay=await startEventRelay(config,{directory,batchWindowMs:10_000,fetch:async(_url,init)=>{batches.push(JSON.parse(init.body));return new Response(null,{status:202})}});
  await emitWriteEvent(config,{type:"stop",body:{context_id:"ctx",turn_id:"final"}},{directory});await relay.close();
  assert.deepEqual(batches.flatMap(batch=>batch.events),[{type:"stop",body:{context_id:"ctx",turn_id:"final"}}]);await rm(directory,{recursive:true,force:true});
});

test("a detached relay daemon survives its launcher and accepts later events",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"hiper-relay-daemon-")),bridges=join(directory,"bridges"),configPath=join(directory,"config.json"),requests=[];
  const server=(await import("node:http")).createServer((req,res)=>{let body="";req.on("data",chunk=>body+=chunk);req.on("end",()=>{requests.push(JSON.parse(body));res.writeHead(202);res.end()})});await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const daemonConfig={gatewayUrl:`http://127.0.0.1:${server.address().port}`,apiKey:"secret"};await writeFile(configPath,JSON.stringify(daemonConfig),"utf8");const env={CBRAIN_AGENT_CONFIG:configPath,CBRAIN_AGENT_BRIDGE_DIR:bridges,CBRAIN_AGENT_RELAY_IDLE_MS:"1000",CBRAIN_AGENT_GATEWAY_URL:"",CBRAIN_AGENT_API_KEY:""};
  try{assert.equal(await ensureEventRelay(daemonConfig,{directory:bridges,env}),true);assert.equal((await inspectEventRelays(daemonConfig,{directory:bridges})).matching.length,1);assert.equal(await emitWriteEvent(daemonConfig,{type:"stop",body:{context_id:"ctx",turn_id:"later"}},{directory:bridges}),true);await waitFor(()=>requests.length===1);assert.equal(requests[0].events[0].type,"stop")}finally{server.close();await rm(directory,{recursive:true,force:true})}
});

test("a detached relay daemon recovers from a stale startup lock",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"hiper-relay-stale-lock-")),bridges=join(directory,"bridges"),configPath=join(directory,"config.json");await mkdir(bridges,{recursive:true});
  const daemonConfig={gatewayUrl:"http://127.0.0.1:9",apiKey:"secret"},fingerprint=configurationFingerprint(daemonConfig),lock=join(bridges,`relay-${fingerprint}.lock`);await writeFile(configPath,JSON.stringify(daemonConfig),"utf8");await writeFile(lock,"","utf8");await utimes(lock,new Date(0),new Date(0));
  const env={CBRAIN_AGENT_CONFIG:configPath,CBRAIN_AGENT_BRIDGE_DIR:bridges,CBRAIN_AGENT_RELAY_IDLE_MS:"1000",CBRAIN_AGENT_GATEWAY_URL:"",CBRAIN_AGENT_API_KEY:""};
  try{assert.equal(await ensureEventRelay(daemonConfig,{directory:bridges,env,startTimeoutMs:1000}),true)}finally{await rm(directory,{recursive:true,force:true})}
});

async function waitFor(predicate,timeoutMs=2000){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10))}assert.fail("condition was not reached")}
