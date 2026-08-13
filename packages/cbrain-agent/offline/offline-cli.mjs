#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { install, parseArguments, promptSecret } from "./installer/installer.mjs";

try {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)));
  const bundle = JSON.parse(await readFile(resolve(sourceRoot, "bundle.json"), "utf8"));
  const installedRoot = resolve(homedir(), ".cbrain-agent", "offline", bundle.client);
  if (sourceRoot !== installedRoot) {
    await rm(installedRoot, { recursive: true, force: true });
    await cp(sourceRoot, installedRoot, { recursive: true });
  }
  const options = parseArguments(["install", bundle.client, ...process.argv.slice(2)]);
  await install({
    ...options,
    sourceRoot: installedRoot,
    readApiKey: () => promptSecret("Cbrain API Key: "),
  });
} catch (error) {
  console.error(`Cbrain offline installation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
