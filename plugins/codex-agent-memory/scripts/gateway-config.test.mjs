import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configPath, loadGatewayConfig, mutateRuntimeState, normalizeGatewayUrl, saveGatewayConfig, statePath } from "./gateway-config.mjs";

test("uses Hiper configuration paths by default", () => {
  const home = join(tmpdir(), "hiper-home");
  assert.equal(configPath({}, home), join(home, ".hiper-agent-memory", "config.json"));
  assert.equal(statePath({}, home), join(home, ".hiper-agent-memory", "state.json"));
});

test("normalizes MCP URL and round-trips user config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hiper-memory-"));
  const path = join(directory, "config.json");
  try {
    await saveGatewayConfig({ gatewayUrl: "http://127.0.0.1:8430/mcp/", apiKey: "secret" }, { path });
    const value = await loadGatewayConfig({ path, env: {}, platform: "linux" });
    assert.equal(value.gatewayUrl, "http://127.0.0.1:8430");
    assert.equal(value.apiKey, "secret");
    assert.deepEqual(JSON.parse(await readFile(path,"utf8")),{gatewayUrl:"http://127.0.0.1:8430",apiKey:"secret"});
    assert.equal("profiles" in value, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("environment overrides file and legacy user environment is a fallback", async () => {
  const path = join(tmpdir(), `missing-${Date.now()}.json`);
  const legacy = await loadGatewayConfig({ path, env: {}, legacyEnvironment: { gatewayUrl: "http://legacy:8430", token: "legacy-token" } });
  assert.equal(legacy.gatewayUrl, "http://legacy:8430");
  const current = await loadGatewayConfig({ path, env: { HIPER_AGENT_GATEWAY_URL: "http://current:8430", HIPER_AGENT_GATEWAY_TOKEN: "current-token" }, legacyEnvironment: {} });
  assert.equal(current.gatewayUrl, "http://current:8430");
  assert.equal(current.token, "current-token");
  assert.equal(normalizeGatewayUrl("http://host:1/mcp"), "http://host:1");
});

test("reads Windows user environment without depending on inherited process values", async () => {
  const path = join(tmpdir(), `missing-${Date.now()}.json`);
  const execFile = async () => ({ stdout: JSON.stringify({ gatewayUrl: null, mcpUrl: "http://windows:8430/mcp", token: "registry-token" }) });
  const value = await loadGatewayConfig({ path, env: {}, platform: "win32", execFile });
  assert.equal(value.gatewayUrl, "http://windows:8430");
  assert.equal(value.token, "registry-token");
});

test("does not launch the legacy environment reader when the config file is complete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hiper-config-fast-"));
  const path = join(directory, "config.json");
  let calls = 0;
  try {
    await saveGatewayConfig({ gatewayUrl: "http://127.0.0.1:8430", apiKey: "secret" }, { path });
    const value = await loadGatewayConfig({ path, env: {}, platform: "win32", execFile: async () => { calls++; throw new Error("must not run"); } });
    assert.equal(value.token, "secret");
    assert.equal(calls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent runtime state mutations merge entries and prune expired sessions",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"hiper-state-lock-")),path=join(directory,"state.json");
  try{
    await Promise.all([mutateRuntimeState((state)=>{state.a={updatedAt:Date.now()};return state},{path}),mutateRuntimeState((state)=>{state.b={updatedAt:Date.now()};return state},{path})]);
    const value=JSON.parse(await readFile(path,"utf8"));assert.ok(value.a);assert.ok(value.b);
    await mutateRuntimeState((state)=>{state.old={updatedAt:1};return state},{path});const pruned=JSON.parse(await readFile(path,"utf8"));assert.equal(pruned.old,undefined);
  }finally{await rm(directory,{recursive:true,force:true})}
});
