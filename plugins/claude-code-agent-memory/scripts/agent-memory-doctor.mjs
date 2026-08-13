#!/usr/bin/env node
import { loadGatewayConfig } from "./gateway-config.mjs";
import { inspectEventRelays } from "./event-relay.mjs";
import { workspaceIdentity } from "./workspace-identity.mjs";

try{
  const config=await loadGatewayConfig(),identity=await workspaceIdentity(process.cwd());
  const response=await fetch(`${config.gatewayUrl}/v1/workspaces/status`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${config.token}`},body:JSON.stringify({workspace_key:identity.key}),signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error(`gateway HTTP ${response.status}`);const result=await response.json();
  console.log(result.status==="bound"?`Hiper Agent Memory: configured, reachable; central binding ${result.team_id}/${result.agent_id}`:"Hiper Agent Memory: configured, reachable; workspace is unbound and will ask for Team/Agent on the first Claude Code prompt");
  const relays=await inspectEventRelays(config);console.log(`Hiper Agent Memory: ${relays.matching.length} active local event relay(s); removed ${relays.staleRemoved} stale descriptor(s)`);
}catch(error){console.error(`Hiper Agent Memory: ${error instanceof Error?error.message:String(error)}`);process.exitCode=1}
