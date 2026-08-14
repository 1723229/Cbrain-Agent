import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRemote, portablePathKey, workspaceIdentity } from "./workspace-identity.mjs";

test("normalizes equivalent Git remotes without retaining credentials",()=>{
  assert.equal(normalizeRemote("git@github.com:Acme/Repo.git"),"github.com/acme/repo");
  assert.equal(normalizeRemote("https://user:secret@github.com/Acme/Repo.git"),"github.com/acme/repo");
});

test("maps Windows and WSL paths to the same portable fallback",()=>{
  assert.equal(portablePathKey("D:\\github\\Repo","win32"),"d:/github/repo");
  assert.equal(portablePathKey("/mnt/d/github/Repo","linux"),"d:/github/repo");
});

test("uses the project Cbrain display label without changing workspace identity",async()=>{
  const identity=await workspaceIdentity("D:/github/Legacy-Repository",{
    env:{},platform:"win32",
    execFile:async(_command,args)=>({stdout:args.includes("--show-toplevel")?"D:/github/Legacy-Repository\n":"https://github.com/example/Legacy-Repository.git\n"}),
    readFile:async()=>JSON.stringify({workspaceLabel:"Cbrain"}),
  });
  assert.equal(identity.label,"Cbrain");
  assert.match(identity.key,/^git:/);
});
