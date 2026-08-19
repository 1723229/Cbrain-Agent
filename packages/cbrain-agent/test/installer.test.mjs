import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execute, install, parseArguments, promptSecret, resolveWindowsCommand, saveConfig, uninstall } from "../src/installer.mjs";

describe("cbrain-agent installer", () => {
  it("installs Codex from the bundled local marketplace and writes only apiKey", async () => {
    const calls = [], home = await mkdtemp(join(tmpdir(), "cbrain-installer-"));
    const runner = async (command, args, options = {}) => { calls.push([command, args]);if(options.capture&&args.includes("marketplace"))return{stdout:JSON.stringify({marketplaces:[]})};if(options.capture)return{stdout:JSON.stringify({installed:[]})};return{stdout:""} };
    const fetcher = async (_url, init) => { assert.equal(init.headers.Authorization, "Bearer page-key");return new Response(JSON.stringify({principal_id:"user:u1",user_id:"u1"}),{status:200}) };
    const result = await install({client:"codex",gatewayUrl:"https://cbrain.example/mcp",apiKey:"page-key",sourceRoot:"/bundle/codex",home,platform:"linux",runner,fetcher,output:()=>{}});
    assert.deepEqual(JSON.parse(await readFile(result.path,"utf8")),{gatewayUrl:"https://cbrain.example",apiKey:"page-key"});
    if(process.platform!=="win32")assert.equal((await stat(result.path)).mode & 0o777,0o600);
    assert.deepEqual(calls.slice(0,2),[["codex",["plugin","marketplace","list","--json"]],["codex",["plugin","list","--json"]]]);
    assert.ok(calls.some(([,args])=>args.join(" ")==="plugin marketplace add /bundle/codex"));
    assert.ok(calls.some(([,args])=>args.includes("cbrain-agent@cbrain")));
    assert.equal(calls.some(([,args])=>args.includes("1723229/Cbrain-Agent")),false);
  });

  it("installs Claude Code and rejects a bad API key before changing plugins", async () => {
    const calls=[];const runner=async(command,args,options={})=>{calls.push([command,args]);return{stdout:options.capture?"[]":""}};
    await assert.rejects(()=>install({client:"claude-code",gatewayUrl:"https://cbrain.example",apiKey:"bad",runner,fetcher:async()=>new Response(JSON.stringify({error:"unauthorized"}),{status:401}),output:()=>{}}),/invalid/);
    assert.equal(calls.length,0);
  });

  it("parses the public one-command interface", () => {
    assert.deepEqual(parseArguments(["install","codex","--gateway","https://cbrain.example"]),{action:"install",client:"codex",gatewayUrl:"https://cbrain.example"});
    assert.deepEqual(parseArguments(["uninstall","claude-code"]),{action:"uninstall",client:"claude-code"});
    assert.throws(()=>parseArguments(["uninstall","codex","--gateway","https://cbrain.example"]),/does not accept/);
    assert.throws(()=>parseArguments(["install","other","--gateway","x"]),/usage/);
  });

  it("refreshes an existing marketplace before reinstalling", async () => {
    const calls=[];const home=await mkdtemp(join(tmpdir(),"cbrain-update-"));
    const runner=async(command,args,options={})=>{calls.push([command,args]);if(options.capture&&args.includes("marketplace"))return{stdout:JSON.stringify({marketplaces:[{name:"cbrain"}]})};if(options.capture)return{stdout:JSON.stringify({installed:[]})};return{stdout:""}};
    await install({client:"codex",gatewayUrl:"https://cbrain.example",apiKey:"key",sourceRoot:"/bundle/codex",home,platform:"linux",runner,fetcher:async()=>new Response(JSON.stringify({user_id:"u"}),{status:200}),output:()=>{}});
    assert.ok(calls.some(([,args])=>args.join(" ")==="plugin marketplace remove cbrain"));
    assert.ok(calls.some(([,args])=>args.join(" ")==="plugin marketplace add /bundle/codex"));
    assert.equal(calls.some(([,args])=>args.join(" ")==="plugin marketplace upgrade cbrain"),false);
  });

  it("updates an installed Claude Code plugin without uninstalling it", async () => {
    const calls=[];const runner=async(command,args,options={})=>{calls.push([command,args]);if(options.capture&&args.includes("marketplace"))return{stdout:JSON.stringify([{name:"cbrain",path:"/bundle/claude-code"}])};if(options.capture&&args.includes("list"))return{stdout:JSON.stringify([{id:"cbrain-agent@cbrain"}])};return{stdout:""}};
    await install({client:"claude-code",gatewayUrl:"https://cbrain.example",apiKey:"key",sourceRoot:"/bundle/claude-code",home:await mkdtemp(join(tmpdir(),"cbrain-claude-update-")),platform:"linux",runner,fetcher:async()=>new Response(JSON.stringify({user_id:"u"}),{status:200}),output:()=>{}});
    assert.ok(calls.some(([,args])=>args.join(" ")==="plugin update cbrain-agent@cbrain --scope user"));
    assert.ok(!calls.some(([,args])=>args.includes("uninstall")));
    assert.ok(!calls.some(([,args])=>args.join(" ")==="plugin marketplace add /bundle/claude-code --scope user"));
  });

  it("installs Codex only from the bundled offline marketplace", async () => {
    const calls=[];const home=await mkdtemp(join(tmpdir(),"cbrain-offline-"));
    const runner=async(command,args,options={})=>{calls.push([command,args]);if(options.capture&&args.includes("marketplace"))return{stdout:JSON.stringify({marketplaces:[{name:"cbrain-offline"}]})};return{stdout:options.capture?JSON.stringify({installed:[]}):""}};
    await install({client:"codex",gatewayUrl:"https://cbrain.example",apiKey:"key",sourceRoot:"/media/cbrain",home,platform:"linux",runner,fetcher:async()=>new Response(JSON.stringify({user_id:"u"}),{status:200}),output:()=>{}});
    assert.ok(calls.some(([,args])=>args.join(" ")==="plugin marketplace remove cbrain-offline"));
    assert.ok(calls.some(([,args])=>args.join(" ")==="plugin marketplace add /media/cbrain"));
    assert.ok(calls.some(([,args])=>args.includes("cbrain-agent@cbrain")));
    assert.ok(!calls.some(([,args])=>args.includes("1723229/Cbrain-Agent")));
  });

  it("installs Claude Code only from the bundled offline marketplace", async () => {
    const calls=[];const home=await mkdtemp(join(tmpdir(),"cbrain-offline-"));
    const runner=async(command,args,options={})=>{calls.push([command,args]);return{stdout:options.capture?"[]":""}};
    await install({client:"claude-code",gatewayUrl:"https://cbrain.example",apiKey:"key",sourceRoot:"/media/cbrain",home,platform:"linux",runner,fetcher:async()=>new Response(JSON.stringify({user_id:"u"}),{status:200}),output:()=>{}});
    assert.ok(calls.some(([,args])=>args.join(" ")==="plugin marketplace add /media/cbrain --scope user"));
    assert.ok(calls.some(([,args])=>args.includes("cbrain-agent@cbrain")));
    assert.ok(!calls.some(([,args])=>args.includes("1723229/Cbrain-Agent")));
  });

  it("resolves standard Windows npm shims without invoking cmd.exe", async () => {
    const codex=await resolveWindowsCommand("codex",{finder:async()=>"C:\\npm\\codex.cmd",readText:async()=>`"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*`,ensureExists:async()=>{}});
    assert.equal(codex.executable,process.execPath);
    assert.equal(codex.prefix[0],"C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js");
    const claude=await resolveWindowsCommand("claude",{finder:async()=>"C:\\npm\\claude.cmd",readText:async()=>`"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*`,ensureExists:async()=>{}});
    assert.equal(claude.executable,"C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe");
    await assert.rejects(()=>resolveWindowsCommand("bad command",{}),/name is invalid/);
  });

  it("grants the Windows user modify access so atomic config upgrades can replace the file", async () => {
    const calls = [], home = await mkdtemp(join(tmpdir(), "cbrain-windows-acl-"));
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "cbrain-test-user";
    try {
      await saveConfig({ gatewayUrl: "https://cbrain.example", apiKey: "key" }, {
        home,
        platform: "win32",
        runner: async (command, args) => { calls.push([command, args]); return { stdout: "" }; },
      });
      assert.deepEqual(calls, [["icacls.exe", [join(home, ".cbrain-agent", "config.json"), "/inheritance:r", "/grant:r", "cbrain-test-user:(M)"]]]);
    } finally {
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
    }
  });

  it("accepts a pasted API Key and Enter delivered in one terminal chunk", async () => {
    const input = fakeTerminalInput(), output = fakeTerminalOutput();
    const secret = promptSecret("Cbrain API Key: ", input, output);
    input.emit("data", "sk-mem-pasted-value\r");
    assert.equal(await secret, "sk-mem-pasted-value");
    assert.equal(output.text, `Cbrain API Key: ${"*".repeat("sk-mem-pasted-value".length)}\n`);
    assert.deepEqual(input.rawModes, [true, false]);
  });

  it("accepts bracketed paste and applies backspace per character", async () => {
    const input = fakeTerminalInput(), output = fakeTerminalOutput();
    const secret = promptSecret("Key: ", input, output);
    input.emit("data", "\u001b[200~abcx\u001b[201~\b");
    input.emit("data", "d\n");
    assert.equal(await secret, "abcd");
    assert.equal(output.text, "Key: ****\b \b*\n");
  });

  it("explains the Windows Codex cache lock without hiding the underlying install phase", async () => {
    const calls = [], home = await mkdtemp(join(tmpdir(), "cbrain-cache-lock-")), runner = async (command, args, options = {}) => {
      calls.push([command, args, options]);
      if (options.capture && args.includes("marketplace")) return { stdout: JSON.stringify({ marketplaces: [{ name: "cbrain" }] }) };
      if (options.capture && args.includes("list")) return { stdout: JSON.stringify({ installed: [] }) };
      if (args.join(" ") === "plugin add cbrain-agent@cbrain") throw new Error("failed to back up plugin cache entry: 拒绝访问。 (os error 5)");
      return { stdout: "" };
    };
    await assert.rejects(
      () => install({ client: "codex", gatewayUrl: "https://cbrain.example", apiKey: "key", sourceRoot: "/bundle/codex", home, runner, fetcher: async () => new Response(JSON.stringify({ user_id: "u" }), { status: 200 }), output: () => {} }),
      /Close all Codex windows and background processes/,
    );
    assert.equal(calls.at(-1)[2].capture, true);
  });

  it("does not save the shared config when plugin installation fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "cbrain-config-rollback-"));
    const runner = async (_command, args, options = {}) => {
      if (options.capture && args.includes("marketplace")) return { stdout: JSON.stringify({ marketplaces: [] }) };
      if (options.capture && args.includes("list")) return { stdout: JSON.stringify({ installed: [] }) };
      if (args.join(" ") === "plugin add cbrain-agent@cbrain") throw new Error("plugin install failed");
      return { stdout: "" };
    };
    await assert.rejects(
      () => install({ client: "codex", gatewayUrl: "https://cbrain.example", apiKey: "key", sourceRoot: "/bundle/codex", home, runner, fetcher: async () => new Response(JSON.stringify({ user_id: "u" }), { status: 200 }), output: () => {} }),
      /plugin install failed/,
    );
    await assert.rejects(access(join(home, ".cbrain-agent", "config.json")), { code: "ENOENT" });
  });

  it("restores previous Codex cachebuster versions after a non-destructive update", async () => {
    const home = await mkdtemp(join(tmpdir(), "cbrain-preserve-update-"));
    const cacheRoot = join(home, ".codex", "plugins", "cache", "cbrain", "cbrain-agent");
    await mkdir(join(cacheRoot, "0.2.3+codex.old"), { recursive: true });
    await writeFile(join(cacheRoot, "0.2.3+codex.old", "marker.txt"), "old");
    const runner = async (_command, args, options = {}) => {
      if (options.capture && args.includes("marketplace")) return { stdout: JSON.stringify({ marketplaces: [{ name: "cbrain" }] }) };
      if (options.capture && args.includes("list")) return { stdout: JSON.stringify({ installed: [] }) };
      if (args.join(" ") === "plugin add cbrain-agent@cbrain") {
        await rm(cacheRoot, { recursive: true, force: true });
        await mkdir(join(cacheRoot, "0.2.3+codex.new"), { recursive: true });
        await writeFile(join(cacheRoot, "0.2.3+codex.new", "marker.txt"), "new");
      }
      return { stdout: "" };
    };
    await install({client:"codex",gatewayUrl:"https://cbrain.example",apiKey:"key",sourceRoot:"/bundle/codex",home,platform:"linux",runner,fetcher:async()=>new Response(JSON.stringify({user_id:"u"}),{status:200}),output:()=>{}});
    await access(join(cacheRoot, "0.2.3+codex.old", "marker.txt"));
    await access(join(cacheRoot, "0.2.3+codex.new", "marker.txt"));
    const backups = await readdir(join(home, ".cbrain-agent", "backups", "codex"));
    assert.equal(backups.length, 1);
    await access(join(home, ".cbrain-agent", "backups", "codex", backups[0], "cache", "0.2.3+codex.old", "marker.txt"));
  });

  it("uninstalls Codex only when explicitly requested and preserves Cbrain configuration", async () => {
    const calls=[],output=[];const runner=async(command,args,options={})=>{calls.push([command,args]);if(options.capture&&args.includes("list"))return{stdout:JSON.stringify({installed:[{pluginId:"cbrain-agent@cbrain"}]})};if(options.capture&&args.includes("remove"))return{stdout:JSON.stringify({removed:true})};return{stdout:""}};
    const result=await execute({action:"uninstall",client:"codex",runner,output:(line)=>output.push(line)});
    assert.deepEqual(calls.at(-1),["codex",["plugin","remove","cbrain-agent@cbrain","--json"]]);
    assert.deepEqual(result,{removed:true,configPreserved:true});
    assert.match(output.join("\n"),/configuration and server-side data were preserved/);
  });

  it("uninstalls Claude Code while preserving Cbrain configuration", async () => {
    const calls=[];const runner=async(command,args,options={})=>{calls.push([command,args]);if(options.capture&&args.includes("list"))return{stdout:JSON.stringify([{id:"cbrain-agent@cbrain"}])};return{stdout:""}};
    await uninstall({client:"claude-code",runner,output:()=>{}});
    assert.deepEqual(calls.at(-1),["claude",["plugin","uninstall","cbrain-agent@cbrain","--scope","user"]]);
  });

  it("treats uninstall as idempotent when the plugin is absent", async () => {
    const calls=[];const runner=async(command,args,options={})=>{calls.push([command,args]);return{stdout:options.capture?JSON.stringify({installed:[]}):""}};
    const result=await uninstall({client:"codex",runner,output:()=>{}});
    assert.deepEqual(result,{removed:false,configPreserved:true});
    assert.equal(calls.some(([,args])=>args.includes("remove")),false);
  });
});

function fakeTerminalInput() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.rawModes = [];
  input.setRawMode = (value) => input.rawModes.push(value);
  input.resume = () => {};
  input.pause = () => {};
  input.setEncoding = () => {};
  return input;
}

function fakeTerminalOutput() {
  return { text: "", write(value) { this.text += value; } };
}
