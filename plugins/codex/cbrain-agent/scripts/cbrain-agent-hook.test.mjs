import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startEventRelay } from "./event-relay.mjs";

test("hook fails open with valid JSON when configuration cannot be read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hiper-hook-"));
  const path = join(directory, "broken.json");
  await writeFile(path, "not-json", "utf8");
  try {
    const result = await runHook(path);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "{}");
    assert.equal(result.stderr, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("write hooks return before the Gateway response and forward the active context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hiper-hook-lifecycle-")),bridgeDirectory=join(directory,"bridges");
  const requests=[];
  const pendingResponses=[];
  const server=createServer((req,res)=>{let body="";req.on("data",(chunk)=>body+=chunk);req.on("end",()=>{requests.push({url:req.url,body:JSON.parse(body||"{}")});if(req.url==="/v1/workspaces/resolve"||req.url==="/v1/hooks/prompt"){res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify(req.url==="/v1/workspaces/resolve"?{status:"bound",team_id:"team",agent_id:"agent",agent_name:"test",context_id:"ctx-1",additionalContext:""}:{additionalContext:""}))}else pendingResponses.push(res)})});
  await new Promise((resolve)=>server.listen(0,"127.0.0.1",resolve));
  const port=server.address().port;
  const config=join(directory,"config.json"),state=join(directory,"state.json");
  await writeFile(config,JSON.stringify({gatewayUrl:`http://127.0.0.1:${port}`,apiKey:"test"}),"utf8");
  const relay=await startEventRelay({gatewayUrl:`http://127.0.0.1:${port}`,apiKey:"test"},{directory:bridgeDirectory,batchWindowMs:20});
  try{
    const env={CBRAIN_AGENT_CONFIG:config,CBRAIN_AGENT_STATE:state,CBRAIN_AGENT_BRIDGE_DIR:bridgeDirectory};
    const sessionStarted=await runHook(config,"session-start",{session_id:"s1",cwd:directory,hook_event_name:"SessionStart"},env);
    const sessionContext=JSON.parse(sessionStarted.stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(sessionContext,/"workspace":/);
    await runHook(config,"user-prompt",{session_id:"s1",turn_id:"t1",cwd:directory,prompt:"implement it",hook_event_name:"UserPromptSubmit"},env);
    const started=Date.now();
    await runHook(config,"tool-use",{session_id:"s1",turn_id:"t1",cwd:directory,tool_use_id:"call-1",tool_name:"Bash",tool_input:{command:"pnpm test"},tool_response:{ok:true}},env);
    await runHook(config,"stop",{session_id:"s1",turn_id:"t1",cwd:directory,last_assistant_message:"implemented and tested"},env);
    await runHook(config,"session-end",{session_id:"s1",cwd:directory,reason:"other"},env);
    assert.ok(Date.now()-started<1500,"write hooks waited for the Gateway response");
    for(const res of pendingResponses.splice(0)){res.writeHead(202,{"Content-Type":"application/json"});res.end(JSON.stringify({accepted:1}))}
    await waitFor(()=>requests.filter(item=>item.url==="/v1/hooks/batch").flatMap(item=>item.body.events).length===3);const events=requests.filter(item=>item.url==="/v1/hooks/batch").flatMap(item=>item.body.events);
    assert.deepEqual(events.map(item=>item.type),["tool_use","stop","session_end"]);
    assert.equal(events[0].body.context_id,"ctx-1");assert.deepEqual(events[0].body.tool_input,{command:"pnpm test"});
    assert.equal(events[1].body.prompt,"implement it");assert.equal(events[2].body.context_id,"ctx-1");
    assert.equal(Object.keys(JSON.parse(await readFile(state,"utf8"))).length,0);
  }finally{for(const res of pendingResponses){res.writeHead(202,{"Content-Type":"application/json"});res.end(JSON.stringify({accepted:1}))}await relay.close();server.close();await rm(directory,{recursive:true,force:true})}
});

test("UserPromptSubmit fails open on timeout and immediately degrades during the circuit window", async () => {
  const directory=await mkdtemp(join(tmpdir(),"hiper-hook-recall-timeout-"));
  const config=join(directory,"config.json"),state=join(directory,"state.json");
  const server=createServer((_req,_res)=>{});await new Promise((resolve)=>server.listen(0,"127.0.0.1",resolve));const port=server.address().port;
  await writeFile(config,JSON.stringify({gatewayUrl:`http://127.0.0.1:${port}`,apiKey:"test"}),"utf8");
  const key=`codex:s1:${directory}`;await writeFile(state,JSON.stringify({[key]:{contextId:"ctx-1",profile:"test",prompt:"previous",turnId:"t0",updatedAt:Date.now()}}),"utf8");
  try{const env={CBRAIN_AGENT_STATE:state};const started=Date.now();const result=await runHook(config,"user-prompt",{session_id:"s1",turn_id:"t1",cwd:directory,prompt:"hello",hook_event_name:"UserPromptSubmit"},env);assert.equal(result.code,0);assert.equal(result.stdout.trim(),"{}");assert.ok(Date.now()-started<1800,"recall exceeded the bounded client timeout");const firstElapsed=Date.now()-started;const secondStarted=Date.now();const second=await runHook(config,"user-prompt",{session_id:"s1",turn_id:"t2",cwd:directory,prompt:"continue",hook_event_name:"UserPromptSubmit"},env);assert.equal(second.stdout.trim(),"{}");assert.ok(Date.now()-secondStarted<500,`open circuit did not degrade immediately after ${firstElapsed}ms`);assert.ok(JSON.parse(await readFile(state,"utf8"))[key].recallCircuitUntil>Date.now())}finally{server.closeAllConnections();server.close();await rm(directory,{recursive:true,force:true})}
});

test("workspace resolution has a bounded timeout and a short fail-open circuit",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"hiper-hook-resolve-timeout-")),config=join(directory,"config.json"),state=join(directory,"state.json"),key=`codex:s-resolve:${directory}`;
  const server=createServer((_req,_res)=>{});await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const port=server.address().port;await writeFile(config,JSON.stringify({gatewayUrl:`http://127.0.0.1:${port}`,apiKey:"test"}),"utf8");const env={CBRAIN_AGENT_STATE:state,CBRAIN_AGENT_WORKSPACE_KEY:"test:resolve-timeout"};
  try{const started=Date.now();const first=await runHook(config,"session-start",{session_id:"s-resolve",cwd:directory,hook_event_name:"SessionStart"},env);assert.equal(first.stdout.trim(),"{}");assert.ok(Date.now()-started<3300);const secondStarted=Date.now();const second=await runHook(config,"session-start",{session_id:"s-resolve",cwd:directory,hook_event_name:"SessionStart"},env);assert.equal(second.stdout.trim(),"{}");assert.ok(Date.now()-secondStarted<500);assert.ok(JSON.parse(await readFile(state,"utf8"))[key].resolveCircuitUntil>Date.now())}finally{server.closeAllConnections();server.close();await rm(directory,{recursive:true,force:true})}
});

test("an unbound workspace asks Codex to select Team and Agent on the first prompt",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"hiper-hook-bootstrap-"));const config=join(directory,"config.json"),state=join(directory,"state.json");const requests=[];
  const server=createServer((req,res)=>{let body="";req.on("data",chunk=>body+=chunk);req.on("end",()=>{requests.push({url:req.url,body:JSON.parse(body||"{}")});res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({status:"unbound",binding_request_id:"bind-1",teams:[{team_id:"team-a",name:"Team A"},{team_id:"team-b",name:"Team B"}],agents:[{agent_id:"agent-a",team_id:"team-a",name:"Codex A"},{agent_id:"agent-b",team_id:"team-b",name:"Codex B"}]}))})});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const port=server.address().port;await writeFile(config,JSON.stringify({gatewayUrl:`http://127.0.0.1:${port}`,apiKey:"test"}),"utf8");const env={CBRAIN_AGENT_CONFIG:config,CBRAIN_AGENT_STATE:state,CBRAIN_AGENT_WORKSPACE_KEY:"test:unbound"};
  try{
    const started=await runHook(config,"session-start",{session_id:"s-bootstrap",cwd:directory,hook_event_name:"SessionStart"},env);const startContext=JSON.parse(started.stdout).hookSpecificOutput.additionalContext;assert.match(startContext,/cbrain_workspace_binding/);assert.match(startContext,/Team A/);
    const prompted=await runHook(config,"user-prompt",{session_id:"s-bootstrap",turn_id:"t1",cwd:directory,prompt:"fix the failing build",hook_event_name:"UserPromptSubmit"},env);const promptContext=JSON.parse(prompted.stdout).hookSpecificOutput.additionalContext;assert.match(promptContext,/workspace_bind/);assert.match(promptContext,/fix the failing build/);assert.equal(requests.some(item=>item.url==="/v1/sessions/open"),false);
  }finally{server.close();await rm(directory,{recursive:true,force:true})}
});

test("a single Team and Agent pair returned by Gateway does not prompt for confirmation",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"hiper-hook-auto-bind-"));const config=join(directory,"config.json"),state=join(directory,"state.json");const requests=[];
  const server=createServer((req,res)=>{let body="";req.on("data",chunk=>body+=chunk);req.on("end",()=>{const parsed=JSON.parse(body||"{}");requests.push({url:req.url,body:parsed});let response;if(req.url==="/v1/workspaces/resolve")response={status:"bound",team_id:"team-one",agent_id:"agent-one",agent_name:"Codex",context_id:"ctx-one",additionalContext:"profile"};else response={additionalContext:"recall"};res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify(response))})});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const port=server.address().port;await writeFile(config,JSON.stringify({gatewayUrl:`http://127.0.0.1:${port}`,apiKey:"test"}),"utf8");const env={CBRAIN_AGENT_CONFIG:config,CBRAIN_AGENT_STATE:state,CBRAIN_AGENT_WORKSPACE_KEY:"test:auto"};
  try{const started=await runHook(config,"session-start",{session_id:"s-auto",cwd:directory,hook_event_name:"SessionStart"},env);assert.doesNotMatch(started.stdout,/cbrain_workspace_binding/);const prompted=await runHook(config,"user-prompt",{session_id:"s-auto",turn_id:"t1",cwd:directory,prompt:"implement it",hook_event_name:"UserPromptSubmit"},env);const context=JSON.parse(prompted.stdout).hookSpecificOutput.additionalContext;assert.match(context,/recall/);assert.doesNotMatch(context,/cbrain_workspace_binding/);assert.equal(requests.some((item)=>item.url==="/v1/workspaces/bind"),false);assert.equal(requests.some((item)=>item.url==="/v1/hooks/prompt"),true)}
  finally{server.close();await rm(directory,{recursive:true,force:true})}
});

test("a stale local pending binding is re-resolved before prompting Codex",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"hiper-hook-stale-binding-"));const config=join(directory,"config.json"),state=join(directory,"state.json"),key=`codex:s-stale:${directory}`,requests=[];
  const server=createServer((req,res)=>{req.resume();req.on("end",()=>{requests.push(req.url);const response=req.url==="/v1/workspaces/resolve"?{status:"bound",team_id:"team-one",agent_id:"agent-one",agent_name:"Codex",context_id:"ctx-stale",additionalContext:"profile"}:{additionalContext:"recalled"};res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify(response))})});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const port=server.address().port;await writeFile(config,JSON.stringify({gatewayUrl:`http://127.0.0.1:${port}`,apiKey:"test"}),"utf8");await writeFile(state,JSON.stringify({[key]:{bindingRequestId:"old-request",bindingExpiresAt:Date.now()+60000,bindingOptions:{teams:[],agents:[]},pendingOriginalPrompt:"old prompt",updatedAt:Date.now()}}));const env={CBRAIN_AGENT_STATE:state,CBRAIN_AGENT_WORKSPACE_KEY:"test:stale"};
  try{const result=await runHook(config,"user-prompt",{session_id:"s-stale",turn_id:"t1",cwd:directory,prompt:"continue",hook_event_name:"UserPromptSubmit"},env);const context=JSON.parse(result.stdout).hookSpecificOutput.additionalContext;assert.match(context,/recalled/);assert.doesNotMatch(context,/cbrain_workspace_binding/);assert.ok(requests.includes("/v1/workspaces/resolve"));assert.ok(requests.includes("/v1/hooks/prompt"))}finally{server.close();await rm(directory,{recursive:true,force:true})}
});

test("workspace_unbind clears the active local context so the next prompt asks again",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"hiper-hook-unbind-")),config=join(directory,"config.json"),state=join(directory,"state.json"),key=`codex:s-unbind:${directory}`;
  const server=createServer((req,res)=>{req.resume();req.on("end",()=>{res.writeHead(req.url==="/v1/hooks/tool-use"?202:200,{"Content-Type":"application/json"});res.end(JSON.stringify(req.url==="/v1/hooks/tool-use"?{accepted:1}:{status:"unbound",binding_request_id:"bind-again",teams:[{team_id:"team",name:"Team"}],agents:[{agent_id:"agent",team_id:"team",name:"Agent"}]}))})});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const port=server.address().port;await writeFile(config,JSON.stringify({gatewayUrl:`http://127.0.0.1:${port}`,apiKey:"test"}),"utf8");await writeFile(state,JSON.stringify({[key]:{contextId:"ctx-old",profile:"Agent",updatedAt:Date.now()}}),"utf8");const env={CBRAIN_AGENT_CONFIG:config,CBRAIN_AGENT_STATE:state,CBRAIN_AGENT_WORKSPACE_KEY:"test:unbind"};
  try{await runHook(config,"tool-use",{session_id:"s-unbind",cwd:directory,tool_use_id:"call-unbind",tool_name:"mcp__cbrain-agent__workspace_unbind",tool_input:{workspace_key:"test:unbind"},tool_response:{removed:true}},env);assert.equal(JSON.parse(await readFile(state,"utf8"))[key],undefined);const prompted=await runHook(config,"user-prompt",{session_id:"s-unbind",cwd:directory,prompt:"continue",hook_event_name:"UserPromptSubmit"},env);assert.match(JSON.parse(prompted.stdout).hookSpecificOutput.additionalContext,/bind-again/)}finally{server.close();await rm(directory,{recursive:true,force:true})}
});

test("workspace_bind consumes the MCP result without a second resolve request",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"hiper-hook-bind-result-")),config=join(directory,"config.json"),state=join(directory,"state.json"),key=`codex:s-bind:${directory}`,requests=[];
  const server=createServer((req,res)=>{let body="";req.on("data",chunk=>body+=chunk);req.on("end",()=>{requests.push({url:req.url,body:JSON.parse(body||"{}")});res.writeHead(req.url==="/v1/hooks/tool-use"?202:200,{"Content-Type":"application/json"});res.end(JSON.stringify(req.url==="/v1/hooks/prompt"?{additionalContext:"recalled"}:{accepted:1}))})});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const port=server.address().port;await writeFile(config,JSON.stringify({gatewayUrl:`http://127.0.0.1:${port}`,apiKey:"test"}),"utf8");await writeFile(state,JSON.stringify({[key]:{bindingRequestId:"bind-1",bindingExpiresAt:Date.now()+60000,bindingOptions:{teams:[],agents:[]},pendingOriginalPrompt:"implement it",updatedAt:Date.now()}}),"utf8");const env={CBRAIN_AGENT_CONFIG:config,CBRAIN_AGENT_STATE:state,CBRAIN_AGENT_WORKSPACE_KEY:"test:bind-result"};
  try{await runHook(config,"tool-use",{session_id:"s-bind",cwd:directory,tool_use_id:"call-bind",tool_name:"mcp__cbrain-agent__workspace_bind",tool_input:{binding_request_id:"bind-1",team_id:"team",agent_id:"agent"},tool_response:{structuredContent:{status:"bound",context_id:"ctx-bound",team_id:"team",agent_id:"agent",agent_name:"Codex"}}},env);const saved=JSON.parse(await readFile(state,"utf8"))[key];assert.equal(saved.contextId,"ctx-bound");const prompted=await runHook(config,"user-prompt",{session_id:"s-bind",turn_id:"t1",cwd:directory,prompt:"continue",hook_event_name:"UserPromptSubmit"},env);assert.match(JSON.parse(prompted.stdout).hookSpecificOutput.additionalContext,/recalled/);assert.equal(requests.some(item=>item.url==="/v1/workspaces/resolve"),false)}finally{server.close();await rm(directory,{recursive:true,force:true})}
});

function runHook(config,mode="session-start",input={},extraEnv={}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./cbrain-agent-hook.mjs", import.meta.url)), "codex", mode], {
      env: { ...process.env, CBRAIN_AGENT_CONFIG: config, CBRAIN_AGENT_GATEWAY_URL: "", CBRAIN_AGENT_GATEWAY_MCP_URL: "", CBRAIN_AGENT_API_KEY: "",...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}
function expectRequest(requests,url){const request=requests.find((item)=>item.url===url);assert.ok(request,`missing ${url}`);return request}
async function waitFor(predicate,timeoutMs=3000){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){if(predicate())return;await new Promise((resolve)=>setTimeout(resolve,25))}assert.fail("timed out waiting for event relay")}
