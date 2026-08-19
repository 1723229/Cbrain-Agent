import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBundle, distributions } from "./bundle-builder.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const argumentsMap = parseArguments(process.argv.slice(2));
const repositoryRoot = resolve(argumentsMap.repositoryRoot || resolve(packageRoot, "../.."));
const outputRoot = resolve(argumentsMap.output || resolve(packageRoot, "bundled"));

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
for (const distribution of distributions) {
  await createBundle({
    repositoryRoot,
    outputRoot: resolve(outputRoot, distribution.client),
    client: distribution.client,
    version: packageJson.version,
  });
}
console.log(outputRoot);

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index++) {
    if (values[index] === "--repository-root") result.repositoryRoot = values[++index];
    else if (values[index] === "--output") result.output = values[++index];
    else throw new Error("unknown option: " + values[index]);
  }
  return result;
}
