import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { install, parseArguments } from "../src/installer.mjs";

describe("cbrain-agent-memory installer", () => {
  it("installs Codex from the remote marketplace and writes only apiKey", async () => {
    const calls = [], home = await mkdtemp(join(tmpdir(), "cbrain-installer-"));
    const runner = async (command, args, options = {}) => { calls.push([command, args]);if(options.capture&&args.includes("marketplace"))return{stdout:JSON.stringify({marketplaces:[]})};if(options.capture)return{stdout:JSON.stringify({installed:[]})};return{stdout:""} };
    const fetcher = async (_url, init) => { assert.equal(init.headers.Authorization, "Bearer page-key");return new Response(JSON.stringify({principal_id:"user:u1",user_id:"u1"}),{status:200}) };
    const result = await install({client:"codex",gatewayUrl:"https://cbrain.example/mcp",apiKey:"page-key",home,platform:"linux",runner,fetcher,output:()=>{}});
    assert.deepEqual(JSON.parse(await readFile(result.path,"utf8")),{gatewayUrl:"https://cbrain.example",apiKey:"page-key"});
    if(process.platform!=="win32")assert.equal((await stat(result.path)).mode & 0o777,0o600);
    assert.deepEqual(calls.slice(0,2),[["codex",["plugin","marketplace","list","--json"]],["codex",["plugin","marketplace","add","1723229/TencentDB-Agent-Memory"]]]);
    assert.ok(calls.some(([,args])=>args.includes("codex-agent-memory@cbrain")));
  });

  it("installs Claude Code and rejects a bad API key before changing plugins", async () => {
    const calls=[];const runner=async(command,args,options={})=>{calls.push([command,args]);return{stdout:options.capture?"[]":""}};
    await assert.rejects(()=>install({client:"claude-code",gatewayUrl:"https://cbrain.example",apiKey:"bad",runner,fetcher:async()=>new Response(JSON.stringify({error:"unauthorized"}),{status:401}),output:()=>{}}),/invalid/);
    assert.equal(calls.length,0);
  });

  it("parses the public one-command interface", () => {
    assert.deepEqual(parseArguments(["install","codex","--gateway","https://cbrain.example"]),{client:"codex",gatewayUrl:"https://cbrain.example"});
    assert.throws(()=>parseArguments(["install","other","--gateway","x"]),/usage/);
  });

  it("refreshes an existing marketplace before reinstalling", async () => {
    const calls=[];const home=await mkdtemp(join(tmpdir(),"cbrain-update-"));
    const runner=async(command,args,options={})=>{calls.push([command,args]);if(options.capture&&args.includes("marketplace"))return{stdout:JSON.stringify({marketplaces:[{name:"cbrain"}]})};if(options.capture)return{stdout:JSON.stringify({installed:[]})};return{stdout:""}};
    await install({client:"codex",gatewayUrl:"https://cbrain.example",apiKey:"key",home,platform:"linux",runner,fetcher:async()=>new Response(JSON.stringify({user_id:"u"}),{status:200}),output:()=>{}});
    assert.ok(calls.some(([,args])=>args.join(" ")==="plugin marketplace upgrade cbrain"));
    assert.ok(!calls.some(([,args])=>args.includes("add")&&args.includes("1723229/TencentDB-Agent-Memory")));
  });
});
