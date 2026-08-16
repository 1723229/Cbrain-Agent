import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const gatewayPort = Number(process.env.CBRAIN_E2E_PORT || 18430);
const baseUrl = `http://127.0.0.1:${gatewayPort}`;
const configured = JSON.parse(await readFile(resolve(homedir(), ".cbrain-agent", "config.json"), "utf8"));
if (!configured.apiKey) throw new Error("local Cbrain API Key configuration is required");
const temporary = await mkdtemp(join(tmpdir(), "cbrain-gateway-e2e-"));

const child = spawn(process.execPath, ["dist/server.mjs"], {
  cwd: resolve(import.meta.dirname, ".."),
  windowsHide: true,
  stdio: ["ignore", "ignore", "pipe"],
  env: {
    ...process.env,
    CBRAIN_AGENT_GATEWAY_HOST: "127.0.0.1",
    CBRAIN_AGENT_GATEWAY_PORT: String(gatewayPort),
    CBRAIN_CORE_URL: process.env.CBRAIN_E2E_CORE_URL || "http://10.0.0.50:8420",
    CBRAIN_KNOWLEDGE_URL: process.env.CBRAIN_E2E_KNOWLEDGE_URL || "http://10.0.0.50:8424",
    CBRAIN_SERVICE_ID: process.env.CBRAIN_E2E_SERVICE_ID || "default",
    CBRAIN_AGENT_GATEWAY_DB: join(temporary, "gateway.sqlite"),
  },
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += String(chunk); });

try {
  await waitUntilReady();
  const fullTools = await rpc("/mcp", "tools/list", {}, 1);
  const wikiTools = await rpc("/mcp/wiki", "tools/list", {}, 2);
  const resourcesCall = await rpc("/mcp/wiki", "tools/call", { name: "wiki_resources", arguments: {} }, 3);
  const resources = toolPayload(resourcesCall);

  const directory = await requestJson("/v1/bindings/options", { method: "POST", body: "{}" });
  const activeAgents=(directory.agents ?? []).filter((item) => item.status === "active" && item.agent_id && item.team_id);
  const agent = activeAgents[0];
  if (!agent) throw new Error("authenticated user has no active Agent for full MCP validation");
  const opened = await requestJson("/v1/sessions/open", { method: "POST", body: JSON.stringify({ host: "e2e", session_id: `e2e-${Date.now()}`, workspace: "cbrain-real-e2e", team_id: agent.team_id, agent_id: agent.agent_id }) });
  const statusCall = await rpc("/mcp", "tools/call", { name: "memory_status", arguments: { context_id: opened.context_id } }, 4);
  const status = toolPayload(statusCall);

  let searchResults = null, searchWarnings = null;
  if (resources.length) {
    const searchCall = await rpc("/mcp/wiki", "tools/call", { name: "wiki_search", arguments: { query: "采购目录校核与替代材料推荐系统设计方案", limit: 5 } }, 5);
    const search = toolPayload(searchCall);
    searchResults = search.results.length;
    searchWarnings = search.warnings.length;
  }

  console.log(JSON.stringify({ health: "ok", fullTools: fullTools.result.tools.length, wikiTools: wikiTools.result.tools.length, activeAgents:activeAgents.length, wikiResources: resources.length, wikiSearchResults: searchResults, wikiWarnings: searchWarnings, memoryContext: status.context_id === opened.context_id }, null, 2));
} finally {
  if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise((done) => child.once("exit", done)); }
  const safeRoot = resolve(tmpdir());
  const safeTarget = resolve(temporary);
  const childPath=relative(safeRoot,safeTarget);
  if (!childPath || childPath.startsWith("..") || isAbsolute(childPath)) throw new Error("refusing to remove a non-temporary E2E directory");
  await rm(safeTarget, { recursive: true, force: true });
}

async function waitUntilReady() {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null) throw new Error(`Gateway exited before readiness: ${stderr.slice(-1000)}`);
    try { const response = await fetch(`${baseUrl}/health/ready`); if (response.ok) return; } catch {}
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`Gateway did not become ready: ${stderr.slice(-1000)}`);
}

async function rpc(path, method, params, id) {
  const response = await requestJson(path, { method: "POST", headers: { Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  if (response.error) throw new Error(`MCP ${method} failed: ${JSON.stringify(response.error)}`);
  return response;
}

async function requestJson(path, init) {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { Authorization: `Bearer ${configured.apiKey}`, "Content-Type": "application/json", ...init.headers }, signal: AbortSignal.timeout(20_000) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path} failed (HTTP ${response.status}): ${JSON.stringify(body)}`);
  return body;
}

function toolPayload(response) {
  if (response.result?.isError) throw new Error(response.result.content?.[0]?.text || "MCP tool failed");
  return JSON.parse(response.result.content[0].text);
}
