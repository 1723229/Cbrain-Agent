import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sharedFiles=["event-relay-daemon.mjs","event-relay.mjs","gateway-config.mjs","gateway-runtime.mjs","mcp-bridge.mjs","workspace-identity.mjs"];

test("packaged Claude runtime stays aligned with the Codex runtime",async()=>{
  for(const name of sharedFiles){
    const claude=await readFile(fileURLToPath(new URL(`./${name}`,import.meta.url)),"utf8");
    const codex=await readFile(fileURLToPath(new URL(`../../cbrain-agent/scripts/${name}`,import.meta.url)),"utf8");
    assert.equal(claude,codex,`${name} drifted; update both packaged clients together`);
  }
});
