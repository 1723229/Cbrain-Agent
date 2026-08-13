#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin,stdout } from "node:process";
import { loadGatewayConfig,saveGatewayConfig } from "./gateway-config.mjs";
import { migrateLegacyPlugin } from "./plugin-migration.mjs";

const args=parseArgs(process.argv.slice(2)),existing=await loadGatewayConfig({optional:true});
const terminal=createInterface({input:stdin,output:stdout});
try{
  const gatewayUrl=args.gatewayUrl||existing?.gatewayUrl||await terminal.question("Gateway URL: ");
  const token=args.token||existing?.token||await terminal.question("Gateway token: ");
  if(args.teamId||args.agentId||args.workspace||args.name)throw new Error("local workspace profiles are no longer supported; bind inside Codex");
  const path=await saveGatewayConfig({gatewayUrl,token});
  console.log(`Hiper Agent Memory configured: ${path}`);
  const migration=await migrateLegacyPlugin();
  if(migration.removed)console.log("Removed the legacy tdai-memory-local Codex plugin registration.");
  for(const warning of migration.warnings)console.warn(`Hiper Agent Memory migration warning: ${warning}`);
  console.log("An unbound workspace will ask for Team and Agent on its first Codex prompt.");
}finally{terminal.close()}

function parseArgs(values){const result={};for(let i=0;i<values.length;i++){const key=values[i];if(key==="--gateway-url")result.gatewayUrl=values[++i];else if(key==="--token")result.token=values[++i];else if(key==="--team-id")result.teamId=values[++i];else if(key==="--agent-id")result.agentId=values[++i];else if(key==="--workspace")result.workspace=values[++i];else if(key==="--name")result.name=values[++i]}return result}
