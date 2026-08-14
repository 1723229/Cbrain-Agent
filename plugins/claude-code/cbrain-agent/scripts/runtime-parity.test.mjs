import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sharedFiles=["event-relay-daemon.mjs","event-relay.mjs","gateway-config.mjs","gateway-runtime.mjs","mcp-bridge.mjs","workspace-identity.mjs"];
const codexScriptsUrl=new URL("../../../codex/cbrain-agent/scripts/",import.meta.url);

test("packaged Claude runtime stays aligned with the Codex runtime",async(t)=>{
  try{await access(fileURLToPath(codexScriptsUrl));}
  catch(error){
    if(error?.code==="ENOENT")return t.skip("Codex source is not present in the installed Claude plugin package");
    throw error;
  }
  for(const name of sharedFiles){
    const claude=await readFile(fileURLToPath(new URL(`./${name}`,import.meta.url)),"utf8");
    const codex=await readFile(fileURLToPath(new URL(name,codexScriptsUrl)),"utf8");
    assert.equal(claude,codex,`${name} drifted; update both packaged clients together`);
  }
});
