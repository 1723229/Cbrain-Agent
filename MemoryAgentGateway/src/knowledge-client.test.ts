import { describe,expect,it } from "vitest";
import { KnowledgeClient } from "./knowledge-client.js";
describe("KnowledgeClient",()=>{it("uses only the configured Knowledge origin",async()=>{
  const calls:string[]=[];const client=new KnowledgeClient({baseUrl:"http://knowledge.test/v3",serviceId:"svc",timeoutMs:1000,fetcher:async(input,init)=>{calls.push(String(input));expect(new Headers(init?.headers).get("x-tdai-service-id")).toBe("svc");return new Response(JSON.stringify({code:0,data:{results:[]}}),{status:200,headers:{"Content-Type":"application/json"}})}});
  await client.callTool("wiki-1","search",{query:"auth"});expect(calls).toEqual(["http://knowledge.test/v3/tools/call"]);
})});
