import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Claude MCP bridge forwards initialize sent immediately after spawn",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"hiper-claude-mcp-")),config=join(directory,"config.json"),bridges=join(directory,"bridges");
  let server;
  try{
    server=createServer(async(request,response)=>{
      let body="";for await(const chunk of request)body+=chunk;const message=JSON.parse(body);
      response.writeHead(200,{"Content-Type":"application/json"});
      response.end(JSON.stringify({jsonrpc:"2.0",id:message.id,result:{protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"gateway",version:"1"}}}));
    });
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    await writeFile(config,JSON.stringify({gatewayUrl:`http://127.0.0.1:${server.address().port}`,token:"test"}));
    const result=await run(config,{HIPER_AGENT_MEMORY_BRIDGE_DIR:bridges});
    assert.equal(result.code,0);assert.equal(JSON.parse(result.stdout).result.serverInfo.name,"gateway");assert.equal(result.stderr,"");
  }finally{server?.close();await rm(directory,{recursive:true,force:true})}
});

function run(config,extraEnv={}){return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL("./mcp-bridge.mjs",import.meta.url))],{env:{...process.env,HIPER_AGENT_MEMORY_CONFIG:config,HIPER_AGENT_GATEWAY_URL:"",HIPER_AGENT_GATEWAY_TOKEN:"",...extraEnv},stdio:["pipe","pipe","pipe"]});
  let stdout="",stderr="";child.stdout.on("data",chunk=>stdout+=chunk);child.stderr.on("data",chunk=>stderr+=chunk);child.on("error",reject);child.on("close",code=>resolve({code,stdout,stderr}));
  child.stdin.end(`${JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"test",version:"1"}}})}\n`);
})}
