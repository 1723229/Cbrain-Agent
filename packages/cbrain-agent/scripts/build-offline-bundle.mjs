import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const productionAsset = (source) => !basename(source).endsWith(".test.mjs");
const distributions = [
  { client: "codex", slug: "cbrain-codex-plugin-offline", pluginPath: "codex/cbrain-agent", marketplace: ".agents/plugins/marketplace.json", agent: "Codex" },
  { client: "claude-code", slug: "cbrain-claude-code-plugin-offline", pluginPath: "claude-code/cbrain-agent", marketplace: ".claude-plugin/marketplace.json", agent: "Claude Code" },
];

for (const distribution of distributions) {
  const outputRoot = resolve(packageRoot, `dist/${distribution.slug}-${packageJson.version}`);
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(resolve(outputRoot, "installer"), { recursive: true });
  await cp(resolve(packageRoot, "offline"), outputRoot, { recursive: true });
  await cp(resolve(packageRoot, "src/installer.mjs"), resolve(outputRoot, "installer/installer.mjs"));
  await cp(resolve(repositoryRoot, `plugins/${distribution.pluginPath}`), resolve(outputRoot, `plugins/${distribution.pluginPath}`), { recursive: true, filter: productionAsset });
  await writeFile(resolve(outputRoot, "bundle.json"), `${JSON.stringify({ client: distribution.client }, null, 2)}\n`);

  const marketplace = JSON.parse(await readFile(resolve(repositoryRoot, distribution.marketplace), "utf8"));
  marketplace.name = "cbrain-offline";
  if (marketplace.interface) marketplace.interface.displayName = "Cbrain Offline";
  const marketplacePath = resolve(outputRoot, distribution.marketplace);
  await mkdir(dirname(marketplacePath), { recursive: true });
  await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
  await writeFile(resolve(outputRoot, "README_CN.md"), readme(distribution.agent));
  console.log(outputRoot);
}

function readme(agent) {
  return `# Cbrain ${agent} Plugin 离线安装包

本包已包含 ${agent} Plugin 和安装器。安装过程不会访问 GitHub 或 npm；运行时需要访问 Cbrain Gateway。

要求：Node.js 22 或更高版本、已安装 ${agent} CLI，并已从 Cbrain 页面创建 API Key。

Windows PowerShell：

\`\`\`powershell
.\\install.ps1 -Gateway http://cbrain.example:8430
\`\`\`

Linux、macOS 或 WSL：

\`\`\`bash
chmod +x install.sh
./install.sh http://cbrain.example:8430
\`\`\`

安装器会隐藏输入 API Key，验证身份并写入 \`~/.cbrain-agent/config.json\`。自动化安装可通过环境变量 \`CBRAIN_API_KEY\` 传入。安装完成后重启 ${agent}。升级时解压新版 ZIP 并重新执行安装脚本。
`;
}
