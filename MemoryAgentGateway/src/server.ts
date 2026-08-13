import { serve } from "@hono/node-server";
import { createAgentGatewayApp } from "./app.js";
import { CaptureWorker } from "./capture-worker.js";
import { loadConfig } from "./config.js";
import { CoreDirectoryClient } from "./core-client.js";
import { GatewayStore } from "./gateway-store.js";
import { KnowledgeClient } from "./knowledge-client.js";
import { AgentGatewayService } from "./service.js";
import { GatewayAuthenticator } from "./auth.js";

const config=loadConfig();const store=new GatewayStore(config.databasePath);const directory=new CoreDirectoryClient(config.core);
const authenticator=new GatewayAuthenticator({directory,staticPrincipals:config.principals,cacheTtlMs:config.authCacheTtlMs,negativeCacheTtlMs:config.authNegativeCacheTtlMs,maxEntries:config.authCacheMaxEntries});
const knowledge=new KnowledgeClient({baseUrl:config.knowledgeBaseUrl,serviceId:config.knowledgeServiceId,token:config.knowledgeToken,timeoutMs:config.core.timeoutMs});
const worker=new CaptureWorker(store,config.core,config.captureConcurrency,config.captureMaxAttempts);
const serviceFactory=(contextId:string,principal:{id:string;userKey?:string})=>{const stored=store.getContext(contextId,principal.id);if(!stored)throw new Error("invalid or expired context_id");const context={...stored,userKey:principal.userKey};return new AgentGatewayService({core:config.core,knowledge,knowledgeIds:config.knowledgeIds,profileMaxChars:config.profileMaxChars,recallTimeoutMs:config.recallTimeoutMs,recallMinScore:config.recallMinScore,sessionContextTimeoutMs:config.sessionContextTimeoutMs,knowledgeCacheTtlMs:config.knowledgeCacheTtlMs,extractionStatus:()=>store.latestSkillExtraction(contextId)},context)};
const app=createAgentGatewayApp({authenticate:(authorization)=>authenticator.authenticate(authorization),store,directory,serviceFactory,contextTtlMs:config.contextTtlMs,skillSettleMs:config.skillSettleMs});
const drain=()=>void worker.drain().catch((error)=>console.error(`[memory-agent-gateway] capture worker failed: ${error instanceof Error?error.message:String(error)}`));
const timer=setInterval(()=>{store.prune();drain()},config.capturePollMs);timer.unref();drain();
serve({fetch:app.fetch,hostname:config.host,port:config.port});console.error(`[memory-agent-gateway] listening on ${config.host}:${config.port}`);
