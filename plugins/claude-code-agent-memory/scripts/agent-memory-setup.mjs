#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadGatewayConfig, saveGatewayConfig } from "./gateway-config.mjs";

const args=parseArgs(process.argv.slice(2)),existing=await loadGatewayConfig({optional:true}),terminal=createInterface({input:stdin,output:stdout});
try{
  const gatewayUrl=args.gatewayUrl||existing?.gatewayUrl||await terminal.question("Gateway URL: ");
  const token=args.token||existing?.token||await terminal.question("Gateway token: ");
  const path=await saveGatewayConfig({gatewayUrl,token});
  console.log(`Hiper Agent Memory configured: ${path}`);
  console.log("An unbound workspace will ask for Team and Agent on its first Claude Code prompt.");
}finally{terminal.close()}

function parseArgs(values){const result={};for(let i=0;i<values.length;i++){if(values[i]==="--gateway-url")result.gatewayUrl=values[++i];else if(values[i]==="--token")result.token=values[++i]}return result}
