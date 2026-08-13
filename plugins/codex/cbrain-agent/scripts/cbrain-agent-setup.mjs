#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin,stdout } from "node:process";
import { loadGatewayConfig,saveGatewayConfig } from "./gateway-config.mjs";

const args=parseArgs(process.argv.slice(2)),existing=await loadGatewayConfig({optional:true});
const terminal=createInterface({input:stdin,output:stdout});
try{
  const gatewayUrl=args.gatewayUrl||existing?.gatewayUrl||await terminal.question("Gateway URL: ");
  const apiKey=args.apiKey||existing?.apiKey||await terminal.question("Cbrain API Key: ");
  if(args.teamId||args.agentId||args.workspace||args.name)throw new Error("local workspace profiles are no longer supported; bind inside Codex");
  const path=await saveGatewayConfig({gatewayUrl,apiKey});
  console.log(`Cbrain configured: ${path}`);
  console.log("An unbound workspace will ask for Team and Agent on its first Codex prompt.");
}finally{terminal.close()}

function parseArgs(values){const result={};for(let i=0;i<values.length;i++){const key=values[i];if(key==="--gateway-url")result.gatewayUrl=values[++i];else if(key==="--api-key")result.apiKey=values[++i];else if(key==="--team-id")result.teamId=values[++i];else if(key==="--agent-id")result.agentId=values[++i];else if(key==="--workspace")result.workspace=values[++i];else if(key==="--name")result.name=values[++i]}return result}
