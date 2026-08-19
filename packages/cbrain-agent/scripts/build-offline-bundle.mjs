import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBundle, distributions } from "./bundle-builder.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));

for (const distribution of distributions) {
  const slug = "cbrain-" + (distribution.client === "codex" ? "codex" : "claude-code") + "-plugin-offline";
  const outputRoot = resolve(packageRoot, "dist/" + slug + "-" + packageJson.version);
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(resolve(outputRoot, "installer"), { recursive: true });
  await cp(resolve(packageRoot, "offline"), outputRoot, { recursive: true });
  await cp(resolve(packageRoot, "src/installer.mjs"), resolve(outputRoot, "installer/installer.mjs"));
  await createBundle({ repositoryRoot, outputRoot, client: distribution.client, version: packageJson.version, clean: false });
  await writeFile(resolve(outputRoot, "README_CN.md"), readme(distribution.agent));
  console.log(outputRoot);
}

function readme(agent) {
  const fence = String.fromCharCode(96).repeat(3);
  return [
    "# Cbrain " + agent + " Plugin 离线安装包",
    "",
    "本包已包含 " + agent + " Plugin 和安装器。安装过程不会访问 GitHub 或 npm；运行时需要访问 Cbrain Gateway。",
    "",
    "要求：Node.js 22 或更高版本、已安装 " + agent + " CLI，并已从 Cbrain 页面创建 API Key。",
    "",
    "Windows PowerShell：",
    "",
    fence + "powershell",
    ".\\install.ps1 -Gateway http://cbrain.example:8430",
    fence,
    "",
    "Linux、macOS 或 WSL：",
    "",
    fence + "bash",
    "chmod +x install.sh",
    "./install.sh http://cbrain.example:8430",
    fence,
    "",
    "安装器会隐藏输入 API Key，验证身份并写入 ~/.cbrain-agent/config.json。自动化安装可通过环境变量 CBRAIN_API_KEY 传入。安装完成后重启 " + agent + "。升级时解压新版 ZIP 并重新执行安装脚本。",
    "",
  ].join("\n");
}
