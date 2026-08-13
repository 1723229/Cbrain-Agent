import { serve } from "@hono/node-server";
import { createAgentGatewayApp } from "./app.js";
import { CaptureWorker } from "./capture-worker.js";
import { loadConfig } from "./config.js";
import { CoreDirectoryClient } from "./core-client.js";
import { GatewayStore } from "./gateway-store.js";
import { KnowledgeClient } from "./knowledge-client.js";
import { AgentGatewayService } from "./service.js";

const config=loadConfig();const store=new GatewayStore(config.databasePath);const directory=new CoreDirectoryClient(config.core);
const knowledge=new KnowledgeClient({baseUrl:config.knowledgeBaseUrl,serviceId:config.knowledgeServiceId,token:config.knowledgeToken,timeoutMs:config.core.timeoutMs});
const worker=new CaptureWorker(store,config.core,config.captureConcurrency,config.captureMaxAttempts);
const serviceFactory=(contextId:string,principal:{id:string})=>{const context=store.getContext(contextId,principal.id);if(!context)throw new Error("invalid or expired context_id");return new AgentGatewayService({core:config.core,knowledge,knowledgeIds:config.knowledgeIds,profileMaxChars:config.profileMaxChars,recallTimeoutMs:config.recallTimeoutMs,recallMinScore:config.recallMinScore,sessionContextTimeoutMs:config.sessionContextTimeoutMs,knowledgeCacheTtlMs:config.knowledgeCacheTtlMs,extractionStatus:()=>store.latestSkillExtraction(contextId)},context)};
const app=createAgentGatewayApp({principals:config.principals,store,directory,serviceFactory,contextTtlMs:config.contextTtlMs,skillSettleMs:config.skillSettleMs});
const drain=()=>void worker.drain().catch((error)=>console.error(`[memory-agent-gateway] capture worker failed: ${error instanceof Error?error.message:String(error)}`));
const timer=setInterval(()=>{store.prune();drain()},config.capturePollMs);timer.unref();drain();
serve({fetch:app.fetch,hostname:config.host,port:config.port});console.error(`[memory-agent-gateway] listening on ${config.host}:${config.port}`);
