import { spawn } from "node:child_process";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { stdin, stdout } from "node:process";

const MARKETPLACE = "cbrain";
const REPOSITORY = "1723229/TencentDB-Agent-Memory";

export function parseArguments(values) {
  if (values[0] !== "install" || !["codex", "claude-code"].includes(values[1])) {
    throw new Error("usage: cbrain-agent-memory install <codex|claude-code> --gateway <url>");
  }
  const result = { client: values[1] };
  for (let index = 2; index < values.length; index++) {
    const value = values[index];
    if (value === "--gateway") result.gatewayUrl = values[++index];
    else if (value === "--api-key") result.apiKey = values[++index];
    else if (value === "--ref") result.ref = values[++index];
    else throw new Error(`unknown option: ${value}`);
  }
  if (!result.gatewayUrl) throw new Error("--gateway is required");
  return result;
}

export async function install(options) {
  const output = options.output ?? console.log;
  const gatewayUrl = normalizeGatewayUrl(options.gatewayUrl);
  const apiKey = clean(options.apiKey || process.env.CBRAIN_API_KEY || await options.readApiKey?.());
  if (!apiKey) throw new Error("Cbrain API Key is required");
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const identity = await verifyIdentity(gatewayUrl, apiKey, fetcher);
  const runner = options.runner ?? runCommand;
  if (options.client === "codex") await installCodex(runner, options.ref);
  else await installClaudeCode(runner, options.ref);
  const path = await saveConfig({ gatewayUrl, apiKey }, options);
  output(`Cbrain connected as ${identity.user_id}.`);
  output(`Configuration saved to ${path}. Restart ${options.client === "codex" ? "Codex" : "Claude Code"}.`);
  return { path, identity };
}

async function installCodex(run, ref) {
  const marketplaces = await jsonCommand(run, "codex", ["plugin", "marketplace", "list", "--json"]);
  if (marketplaces.marketplaces?.some((item) => item.name === MARKETPLACE)) {
    await run("codex", ["plugin", "marketplace", "upgrade", MARKETPLACE]);
  } else {
    const args = ["plugin", "marketplace", "add", REPOSITORY];
    if (ref) args.push("--ref", ref);
    await run("codex", args);
  }
  await run("codex", ["plugin", "add", `codex-agent-memory@${MARKETPLACE}`]);
  const plugins = await jsonCommand(run, "codex", ["plugin", "list", "--json"]);
  if (plugins.installed?.some((item) => item.pluginId === "codex-agent-memory@hiper-memory-local")) {
    await run("codex", ["plugin", "remove", "codex-agent-memory@hiper-memory-local"]);
  }
}

async function installClaudeCode(run, ref) {
  if (ref) throw new Error("--ref is only supported by the Codex marketplace command");
  const marketplaces = await jsonCommand(run, "claude", ["plugin", "marketplace", "list", "--json"]);
  if (marketplaces.some?.((item) => item.name === MARKETPLACE)) {
    await run("claude", ["plugin", "marketplace", "update", MARKETPLACE]);
  } else {
    await run("claude", ["plugin", "marketplace", "add", REPOSITORY, "--scope", "user"]);
  }
  await run("claude", ["plugin", "install", `claude-code-agent-memory@${MARKETPLACE}`, "--scope", "user"]);
  const plugins = await jsonCommand(run, "claude", ["plugin", "list", "--json"]);
  if (plugins.some?.((item) => item.id === "claude-code-agent-memory@hiper-memory-local")) {
    await run("claude", ["plugin", "uninstall", "claude-code-agent-memory@hiper-memory-local", "--scope", "user"]);
  }
}

async function jsonCommand(run, command, args) {
  const result = await run(command, args, { capture: true });
  try { return JSON.parse(result.stdout || "null"); }
  catch { throw new Error(`${command} returned invalid JSON while inspecting plugins`); }
}

async function verifyIdentity(gatewayUrl, apiKey, fetcher) {
  let response;
  try {
    response = await fetcher(`${gatewayUrl}/v1/auth/me`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    throw new Error(`cannot reach Gateway: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = await response.json().catch(() => null);
  if (response.status === 401) throw new Error("Cbrain API Key is invalid");
  if (!response.ok || !body?.user_id) throw new Error(body?.error || `Gateway verification failed (HTTP ${response.status})`);
  return body;
}

export async function saveConfig({ gatewayUrl, apiKey }, options = {}) {
  const path = options.configPath || resolve(options.home || homedir(), ".hiper-agent-memory", "config.json");
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ gatewayUrl, apiKey }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  if ((options.platform || process.platform) !== "win32") await chmod(path, 0o600);
  else await hardenWindowsAcl(path, options.runner ?? runCommand);
  return path;
}

async function hardenWindowsAcl(path, run) {
  const username = process.env.USERNAME;
  if (!username) return;
  try { await run("icacls.exe", [path, "/inheritance:r", "/grant:r", `${username}:(R,W)`]); }
  catch { /* The user profile ACL remains the fallback. */ }
}

export function normalizeGatewayUrl(value) {
  const url = new URL(clean(value));
  if (!/^https?:$/.test(url.protocol)) throw new Error("Gateway URL must use HTTP or HTTPS");
  url.pathname = url.pathname.replace(/\/mcp\/?$/, "").replace(/\/+$/, "");
  url.search = ""; url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function runCommand(command, args, options = {}) {
  const executable = process.platform === "win32" && !command.endsWith(".exe") ? `${command}.cmd` : command;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdoutText = "", stderrText = "";
    child.stdout?.on("data", (chunk) => { stdoutText += chunk; });
    child.stderr?.on("data", (chunk) => { stderrText += chunk; });
    child.on("error", (error) => reject(new Error(`cannot run ${command}: ${error.message}`)));
    child.on("close", (code) => code === 0 ? resolvePromise({ stdout: stdoutText, stderr: stderrText }) : reject(new Error(`${command} exited with code ${code}${stderrText ? `: ${stderrText.trim()}` : ""}`)));
  });
}

export function promptSecret(label, input = stdin, output = stdout) {
  if (!input.isTTY || typeof input.setRawMode !== "function") throw new Error("interactive terminal required; set CBRAIN_API_KEY for automation");
  output.write(label); input.setRawMode(true); input.resume(); input.setEncoding("utf8");
  return new Promise((resolvePromise, reject) => {
    let value = "";
    const cleanup = () => { input.off("data", onData); input.setRawMode(false); input.pause(); output.write("\n"); };
    const onData = (key) => {
      if (key === "\u0003") { cleanup(); reject(new Error("cancelled")); return; }
      if (key === "\r" || key === "\n") { cleanup(); resolvePromise(value); return; }
      if (key === "\u007f" || key === "\b") { if (value) { value = value.slice(0, -1); output.write("\b \b"); } return; }
      if (/^[^\u0000-\u001f]+$/.test(key)) { value += key; output.write("*"); }
    };
    input.on("data", onData);
  });
}

function clean(value) { return typeof value === "string" ? value.trim() : ""; }
