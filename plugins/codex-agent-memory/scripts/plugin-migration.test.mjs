import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { legacyPluginDetected, migrateLegacyPlugin } from "./plugin-migration.mjs";

test("legacy plugin migration uses Codex commands instead of editing config",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"hiper-migration-")),configPath=join(directory,"config.toml"),calls=[];
  await writeFile(configPath,'[marketplaces.tdai-memory-local]\nsource_type = "local"\n[plugins."codex-agent-memory@tdai-memory-local"]\nenabled = true\n',"utf8");
  try{
    assert.equal(await legacyPluginDetected({configPath}),true);
    const result=await migrateLegacyPlugin({configPath,run:async args=>calls.push(args)});
    assert.equal(result.removed,true);assert.deepEqual(calls,[
      ["plugin","remove","codex-agent-memory@tdai-memory-local","--json"],
      ["plugin","marketplace","remove","tdai-memory-local","--json"],
    ]);
  }finally{await rm(directory,{recursive:true,force:true})}
});

test("migration is a no-op when no legacy marker exists",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"hiper-migration-clean-")),configPath=join(directory,"config.toml");let called=false;
  await writeFile(configPath,"[plugins]\n","utf8");
  try{assert.deepEqual(await migrateLegacyPlugin({configPath,run:async()=>{called=true}}),{detected:false,removed:false,warnings:[]});assert.equal(called,false)}finally{await rm(directory,{recursive:true,force:true})}
});

test("default discovery reads config.toml below the Codex home directory",async()=>{
  const home=await mkdtemp(join(tmpdir(),"hiper-migration-home-")),codexHome=join(home,".codex");
  await mkdir(codexHome);await writeFile(join(codexHome,"config.toml"),'[marketplaces.tdai-memory-local]\n',"utf8");
  try{assert.equal(await legacyPluginDetected({home,env:{}}),true)}finally{await rm(home,{recursive:true,force:true})}
});

test("obsolete hook trust hashes alone do not count as an active legacy plugin",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"hiper-migration-hook-state-")),configPath=join(directory,"config.toml");await writeFile(configPath,'[hooks.state."codex-agent-memory@tdai-memory-local:hooks/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:test"\n',"utf8");
  try{assert.equal(await legacyPluginDetected({configPath}),false)}finally{await rm(directory,{recursive:true,force:true})}
});

test("an orphaned disabled plugin entry is not active without its marketplace",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"hiper-migration-orphan-")),configPath=join(directory,"config.toml");await writeFile(configPath,'[plugins."codex-agent-memory@tdai-memory-local"]\nenabled = true\n',"utf8");
  try{assert.equal(await legacyPluginDetected({configPath}),false)}finally{await rm(directory,{recursive:true,force:true})}
});
