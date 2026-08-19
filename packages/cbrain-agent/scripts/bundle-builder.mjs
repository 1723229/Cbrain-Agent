import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export const distributions = [
  { client: "codex", pluginPath: "codex/cbrain-agent", marketplace: ".agents/plugins/marketplace.json", agent: "Codex" },
  { client: "claude-code", pluginPath: "claude-code/cbrain-agent", marketplace: ".claude-plugin/marketplace.json", agent: "Claude Code" },
];

export const productionAsset = (source) => !basename(source).endsWith(".test.mjs");

export async function createBundle({ repositoryRoot, outputRoot, client, marketplaceName = "cbrain", version, clean = true }) {
  const distribution = distributions.find((item) => item.client === client);
  if (!distribution) throw new Error("unsupported bundled client: " + client);

  if (clean) await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });

  await cp(
    resolve(repositoryRoot, "plugins", distribution.pluginPath),
    resolve(outputRoot, "plugins", distribution.pluginPath),
    { recursive: true, filter: productionAsset },
  );

  const marketplace = JSON.parse(await readFile(resolve(repositoryRoot, distribution.marketplace), "utf8"));
  marketplace.name = marketplaceName;
  if (marketplace.interface) marketplace.interface.displayName = "Cbrain";
  const marketplacePath = resolve(outputRoot, distribution.marketplace);
  await mkdir(dirname(marketplacePath), { recursive: true });
  await writeFile(marketplacePath, JSON.stringify(marketplace, null, 2) + "\n");
  await writeFile(resolve(outputRoot, "bundle.json"), JSON.stringify({ client, marketplace: marketplaceName, version }, null, 2) + "\n");
  return outputRoot;
}
