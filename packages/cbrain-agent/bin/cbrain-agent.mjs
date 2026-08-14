#!/usr/bin/env node
import { execute, parseArguments, promptSecret } from "../src/installer.mjs";

try {
  const options = parseArguments(process.argv.slice(2));
  await execute({ ...options, readApiKey: () => promptSecret("Cbrain API Key: ") });
} catch (error) {
  console.error(`Cbrain installation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
