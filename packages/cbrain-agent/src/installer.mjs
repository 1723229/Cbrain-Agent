import { spawn } from "node:child_process";
import { access, chmod, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

const MARKETPLACE = "cbrain";
const OFFLINE_MARKETPLACE = "cbrain-offline";

export function parseArguments(values) {
  if (!["install", "uninstall"].includes(values[0]) || !["codex", "claude-code"].includes(values[1])) {
    throw new Error("usage: cbrain-agent <install|uninstall> <codex|claude-code> [--gateway <url>]");
  }
  const result = { action: values[0], client: values[1] };
  for (let index = 2; index < values.length; index++) {
    const value = values[index];
    if (value === "--gateway") result.gatewayUrl = values[++index];
    else if (value === "--api-key") result.apiKey = values[++index];
    else if (value === "--ref") result.ref = values[++index];
    else throw new Error(`unknown option: ${value}`);
  }
  if (result.action === "install" && !result.gatewayUrl) throw new Error("--gateway is required for install");
  if (result.action === "uninstall" && (result.gatewayUrl || result.apiKey || result.ref)) throw new Error("uninstall does not accept install options");
  return result;
}

export async function execute(options) {
  return options.action === "uninstall" ? uninstall(options) : install(options);
}

export async function install(options) {
  const output = options.output ?? console.log;
  const gatewayUrl = normalizeGatewayUrl(options.gatewayUrl);
  const apiKey = clean(options.apiKey || process.env.CBRAIN_API_KEY || await options.readApiKey?.());
  if (!apiKey) throw new Error("Cbrain API Key is required");
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const identity = await verifyIdentity(gatewayUrl, apiKey, fetcher);
  const runner = options.runner ?? runCommand;
  const sourceRoot = options.sourceRoot || await materializeEmbeddedMarketplace(options.client, options);
  if (!sourceRoot) throw new Error("Cbrain installer bundle is missing the embedded plugin Marketplace.");
  if (options.ref) throw new Error("--ref is not supported by the self-contained Cbrain installer");
  const snapshot = options.client === "codex" ? await snapshotCodexState(options) : null;
  try {
    if (options.client === "codex") await installCodex(runner, sourceRoot);
    else await installClaudeCode(runner, sourceRoot);
  } catch (error) {
    throw normalizePluginInstallError(error, options.client);
  } finally {
    if (snapshot) await restoreCodexVersions(snapshot);
  }
  const path = await saveConfig({ gatewayUrl, apiKey }, options);
  output("Cbrain connected as " + identity.user_id + ".");
  if (snapshot) output("Previous Codex plugin versions preserved in " + snapshot.backupRoot + ".");
  output("Configuration saved to " + path + ". Restart " + (options.client === "codex" ? "Codex" : "Claude Code") + ".");
  return { path, identity };
}

async function installCodex(run, sourceRoot) {
  await replaceLocalMarketplace(run, "codex", sourceRoot);
  await run("codex", ["plugin", "add", "cbrain-agent@" + MARKETPLACE], { capture: true });
}

async function installClaudeCode(run, sourceRoot) {
  await replaceLocalMarketplace(run, "claude-code", sourceRoot);
  const plugins = await jsonCommand(run, "claude", ["plugin", "list", "--json"]);
  const installed = Array.isArray(plugins) && plugins.some((item) => item.id === "cbrain-agent@" + MARKETPLACE);
  await run("claude", ["plugin", installed ? "update" : "install", "cbrain-agent@" + MARKETPLACE, "--scope", "user"]);
}

export async function uninstall(options) {
  const output = options.output ?? console.log;
  const runner = options.runner ?? runCommand;
  let removed = false;
  if (options.client === "codex") {
    const plugins = await jsonCommand(runner, "codex", ["plugin", "list", "--json"]);
    const installed = Array.isArray(plugins.installed) && plugins.installed.some((item) => item.pluginId === `cbrain-agent@${MARKETPLACE}`);
    if (installed) await runner("codex", ["plugin", "remove", `cbrain-agent@${MARKETPLACE}`, "--json"], { capture: true });
    removed = installed;
    output(installed ? "Cbrain plugin removed from Codex." : "Cbrain plugin is not installed in Codex.");
  } else {
    const plugins = await jsonCommand(runner, "claude", ["plugin", "list", "--json"]);
    const installed = Array.isArray(plugins) && plugins.some((item) => item.id === `cbrain-agent@${MARKETPLACE}`);
    if (installed) await runner("claude", ["plugin", "uninstall", `cbrain-agent@${MARKETPLACE}`, "--scope", "user"]);
    removed = installed;
    output(installed ? "Cbrain plugin removed from Claude Code." : "Cbrain plugin is not installed in Claude Code.");
  }
  output("Cbrain connection configuration and server-side data were preserved.");
  return { removed, configPreserved: true };
}

async function replaceLocalMarketplace(run, client, sourceRoot) {
  const command = client === "codex" ? "codex" : "claude";
  const marketplaces = await jsonCommand(run, command, ["plugin", "marketplace", "list", "--json"]);
  const plugins = await jsonCommand(run, command, ["plugin", "list", "--json"]);
  const entries = client === "codex" ? (marketplaces.marketplaces || []) : (Array.isArray(marketplaces) ? marketplaces : []);
  const current = entries.find((item) => item.name === MARKETPLACE);
  const legacy = entries.find((item) => item.name === OFFLINE_MARKETPLACE);
  const legacyPluginId = "cbrain-agent@" + OFFLINE_MARKETPLACE;
  const legacyPluginInstalled = client === "codex"
    ? plugins.installed?.some((item) => item.pluginId === legacyPluginId)
    : Array.isArray(plugins) && plugins.some((item) => item.id === legacyPluginId);
  if (current && !sameLocalPath(marketplaceRoot(current), sourceRoot)) await removeMarketplaceInstallation(run, client, MARKETPLACE, plugins, entries);
  if (legacy || legacyPluginInstalled) await removeMarketplaceInstallation(run, client, OFFLINE_MARKETPLACE, plugins, entries);
  const refreshed = current && sameLocalPath(marketplaceRoot(current), sourceRoot);
  if (!refreshed) {
    if (client === "codex") await run("codex", ["plugin", "marketplace", "add", sourceRoot]);
    else await run("claude", ["plugin", "marketplace", "add", sourceRoot, "--scope", "user"]);
  }
}

async function removeMarketplaceInstallation(run, client, name, plugins, marketplaces) {
  const pluginId = "cbrain-agent@" + name;
  const installed = client === "codex"
    ? plugins.installed?.some((item) => item.pluginId === pluginId)
    : Array.isArray(plugins) && plugins.some((item) => item.id === pluginId);
  if (installed) {
    if (client === "codex") await run("codex", ["plugin", "remove", pluginId, "--json"], { capture: true });
    else await run("claude", ["plugin", "uninstall", pluginId, "--scope", "user"]);
  }
  const present = marketplaces.some((item) => item.name === name);
  if (present) {
    if (client === "codex") await run("codex", ["plugin", "marketplace", "remove", name]);
    // Older Claude Code releases support --scope for marketplace add, but not remove.
    // Omitting it works on both those releases and the current CLI.
    else await run("claude", ["plugin", "marketplace", "remove", name]);
  }
}

function marketplaceRoot(entry) { return entry?.root || entry?.path || entry?.source?.path || ""; }
function sameLocalPath(left, right) { return normalizeLocalPath(left) === normalizeLocalPath(right); }
function normalizeLocalPath(value) {
  const text = String(value || "").replace(/^\\\\\?\\/, "");
  return text ? resolve(text).replace(/\\+$/, "").replaceAll("\\", "/").toLowerCase() : "";
}

async function jsonCommand(run, command, args) {
  const result = await run(command, args, { capture: true });
  try { return JSON.parse(result.stdout || "null"); }
  catch { throw new Error(`${command} returned invalid JSON while inspecting plugins`); }
}

async function materializeEmbeddedMarketplace(client, options = {}) {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const embeddedRoot = resolve(packageRoot, "bundled", client);
  if (!(await exists(embeddedRoot))) return null;
  const installedRoot = resolve(options.home || homedir(), ".cbrain-agent", "bundled", client);
  await rm(installedRoot, { recursive: true, force: true });
  await cp(embeddedRoot, installedRoot, { recursive: true });
  return installedRoot;
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
  const path = options.configPath || resolve(options.home || homedir(), ".cbrain-agent", "config.json");
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
  // Atomic upgrades replace config.json with rename(), which requires delete
  // permission on Windows in addition to read/write permission.
  try { await run("icacls.exe", [path, "/inheritance:r", "/grant:r", `${username}:(M)`]); }
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
  const platform = options.platform || process.platform;
  return new Promise((resolvePromise, reject) => {
    Promise.resolve(platform === "win32" && !command.endsWith(".exe") ? resolveWindowsCommand(command, options) : { executable: command, args })
      .then(({ executable, prefix = [] }) => {
        const child = spawn(executable, [...prefix, ...args], { windowsHide: true, stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit" });
        let stdoutText = "", stderrText = "";
        child.stdout?.on("data", (chunk) => { stdoutText += chunk; });
        child.stderr?.on("data", (chunk) => { stderrText += chunk; });
        child.on("error", (error) => reject(new Error(`cannot run ${command}: ${error.message}`)));
        child.on("close", (code) => code === 0 ? resolvePromise({ stdout: stdoutText, stderr: stderrText }) : reject(new Error(`${command} exited with code ${code}${stderrText ? `: ${stderrText.trim()}` : ""}`)));
      }, reject);
  });
}

export async function resolveWindowsCommand(command, options = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(command)) throw new Error("Windows command name is invalid");
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const finder = options.finder ?? findWindowsCommand;
  const executable = await finder(command, pathValue);
  if (!executable) throw new Error(`cannot find ${command}.exe or ${command}.cmd on PATH`);
  const extension = extname(executable).toLowerCase();
  if (extension === ".exe") return { executable, prefix: [] };
  if (extension !== ".cmd") throw new Error(`unsupported Windows command launcher: ${executable}`);

  const shim = executable;
  const content = await (options.readText ?? readFile)(shim, "utf8");
  const matches = [...content.matchAll(/"%dp0%\\([^"\r\n]+\.(?:js|exe))"/gi)];
  const target = matches.at(-1)?.[1];
  if (!target || target.includes("..")) throw new Error(`cannot resolve the executable behind ${command}.cmd`);
  const targetPath = resolve(dirname(shim), target);
  await (options.ensureExists ?? access)(targetPath);
  return target.toLowerCase().endsWith(".js")
    ? { executable: process.execPath, prefix: [targetPath] }
    : { executable: targetPath, prefix: [] };
}

function normalizePluginInstallError(error, client) {
  const message = error instanceof Error ? error.message : String(error);
  if (client === "codex" && /failed to back up plugin cache entry|os error 5|access is denied|拒绝访问/i.test(message)) {
    return new Error("Codex is using the existing Cbrain plugin cache. Close all Codex windows and background processes, then run this command again.");
  }
  return error instanceof Error ? error : new Error(message);
}

async function snapshotCodexState(options = {}) {
  const userHome = options.home || homedir();
  const codexHome = options.codexHome || process.env.CODEX_HOME || resolve(userHome, ".codex");
  const cacheRoot = resolve(codexHome, "plugins", "cache", MARKETPLACE, "cbrain-agent");
  if (!(await exists(cacheRoot))) return null;
  const backupRoot = resolve(userHome, ".cbrain-agent", "backups", "codex", timestamp());
  const backupCache = resolve(backupRoot, "cache");
  await mkdir(backupRoot, { recursive: true });
  await cp(cacheRoot, backupCache, { recursive: true, errorOnExist: true });
  const codexConfig = resolve(codexHome, "config.toml");
  if (await exists(codexConfig)) await cp(codexConfig, resolve(backupRoot, "config.toml"), { errorOnExist: true });
  return { backupRoot, backupCache, cacheRoot, versions: await directoryNames(backupCache) };
}

async function restoreCodexVersions(snapshot) {
  await mkdir(snapshot.cacheRoot, { recursive: true });
  for (const version of snapshot.versions) {
    const destination = resolve(snapshot.cacheRoot, version);
    if (!(await exists(destination))) await cp(resolve(snapshot.backupCache, version), destination, { recursive: true, errorOnExist: true });
  }
}

async function directoryNames(path) {
  return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function timestamp() {
  return new Date().toISOString().replace(/[-:.]/g, "");
}

async function findWindowsCommand(name, pathValue) {
  const names = extname(name) ? [name] : [`${name}.exe`, `${name}.cmd`];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const candidateName of names) {
      const candidate = join(directory.replace(/^"|"$/g, ""), candidateName);
      try { await access(candidate); return candidate; } catch { /* Continue searching PATH. */ }
    }
  }
  return null;
}

export function promptSecret(label, input = stdin, output = stdout) {
  if (!input.isTTY || typeof input.setRawMode !== "function") throw new Error("interactive terminal required; set CBRAIN_API_KEY for automation");
  output.write(label); input.setRawMode(true); input.resume(); input.setEncoding("utf8");
  return new Promise((resolvePromise, reject) => {
    let value = "";
    const cleanup = () => { input.off("data", onData); input.setRawMode(false); input.pause(); output.write("\n"); };
    const onData = (chunk) => {
      const text = String(chunk).replaceAll("\u001b[200~", "").replaceAll("\u001b[201~", "");
      for (const key of text) {
        if (key === "\u0003") { cleanup(); reject(new Error("cancelled")); return; }
        if (key === "\r" || key === "\n") { cleanup(); resolvePromise(value); return; }
        if (key === "\u007f" || key === "\b") {
          if (value) { value = [...value].slice(0, -1).join(""); output.write("\b \b"); }
          continue;
        }
        if (!/[\u0000-\u001f\u007f]/u.test(key)) { value += key; output.write("*"); }
      }
    };
    input.on("data", onData);
  });
}

function clean(value) { return typeof value === "string" ? value.trim() : ""; }
