import { mkdtempSync } from "node:fs";import { tmpdir } from "node:os";import { join } from "node:path";import { describe,expect,it } from "vitest";import { GatewayStore } from "./gateway-store.js";
import { DatabaseSync } from "node:sqlite";
describe("GatewayStore",()=>{it("isolates contexts by principal and persists independent sink state",()=>{const store=new GatewayStore(join(mkdtempSync(join(tmpdir(),"store-test-")),"db.sqlite"));const principal={id:"p1",token:"x",userId:"u1"};const ctx=store.openContext(principal,{teamId:"t1",userId:"u1",agentId:"a1"},{host:"codex",sessionId:"s1",workspace:"/repo"},60000);expect(store.getContext(ctx.contextId,"p2")).toBeNull();store.beginTurn(ctx.contextId,"turn","hello");const queued=store.enqueueCapture(ctx.contextId,"turn","world");expect(queued.duplicate).toBe(false);store.markSink(queued.eventId,"core");expect(store.dueCaptures()[0]).toMatchObject({coreStatus:"done",skillStatus:"pending"});expect(store.enqueueCapture(ctx.contextId,"turn","world","hello").duplicate).toBe(true)})});

describe("GatewayStore workspace bindings",()=>{
  it("persists a principal-scoped binding through a one-time request",()=>{
    const store=new GatewayStore(join(mkdtempSync(join(tmpdir(),"workspace-binding-test-")),"db.sqlite"));
    const request=store.issueWorkspaceBindingRequest("p1",{workspaceKey:"git:abc",workspaceLabel:"repo",host:"codex",sessionId:"s1",workspace:"C:/repo"},60_000);
    expect(store.getWorkspaceBinding("p1","git:abc")).toBeNull();
    const completed=store.completeWorkspaceBinding(request.requestId,"p1",{teamId:"team-1",userId:"user-1",agentId:"agent-1",agentName:"Codex"});
    expect(completed.request).toMatchObject({workspaceKey:"git:abc",sessionId:"s1"});
    expect(store.getWorkspaceBinding("p1","git:abc")).toMatchObject({teamId:"team-1",agentId:"agent-1",agentName:"Codex"});
    expect(store.getWorkspaceBinding("p2","git:abc")).toBeNull();
    expect(()=>store.completeWorkspaceBinding(request.requestId,"p2",{teamId:"team-1",userId:"user-2",agentId:"agent-1"})).toThrow("binding request");
    expect(store.removeWorkspaceBinding("p1","git:abc")).toBe(true);
    expect(store.removeWorkspaceBinding("p1","git:abc")).toBe(false);
    expect(store.getWorkspaceBinding("p1","git:abc")).toBeNull();
    expect(()=>store.completeWorkspaceBinding(request.requestId,"p1",{teamId:"team-1",userId:"user-1",agentId:"agent-1"})).toThrow("binding request");
  });
});

describe("GatewayStore skill extraction",()=>{
  it("migrates the pre-tool-trace capture schema in place",()=>{
    const path=join(mkdtempSync(join(tmpdir(),"gateway-migration-test-")),"db.sqlite");const db=new DatabaseSync(path);
    db.exec("CREATE TABLE capture_events(event_id TEXT PRIMARY KEY,context_id TEXT NOT NULL,user_text TEXT NOT NULL,assistant_text TEXT NOT NULL,core_status TEXT NOT NULL DEFAULT 'pending',skill_status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL,last_error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");db.close();
    new GatewayStore(path);
    const check=new DatabaseSync(path);const columns=check.prepare("PRAGMA table_info(capture_events)").all() as unknown as Array<{name:string}>;expect(columns.map((item)=>item.name)).toContain("turn_id");check.close();
  });
  it("assembles a turn with tool calls and queues one idempotent session extraction",()=>{
    const store=new GatewayStore(join(mkdtempSync(join(tmpdir(),"skill-store-test-")),"db.sqlite"));
    const ctx=store.openContext({id:"p",token:"x",userId:"u"},{teamId:"t",userId:"u",agentId:"a"},{host:"codex",sessionId:"s",workspace:"/repo"},60000);
    store.beginTurn(ctx.contextId,"turn-1","fix the failing test");
    expect(store.recordToolUse(ctx.contextId,"turn-1","call-1","Bash",{command:"pnpm test",token:"secret"},{exitCode:0,output:"passed"}).duplicate).toBe(false);
    expect(store.recordToolUse(ctx.contextId,"turn-1","call-1","Bash",{},{}).duplicate).toBe(true);
    store.enqueueCapture(ctx.contextId,"turn-1","Fixed the test and verified it.");
    const first=store.enqueueSkillExtraction(ctx.contextId,"session complete");
    const second=store.enqueueSkillExtraction(ctx.contextId,"session complete");
    expect(first.duplicate).toBe(false);expect(second).toMatchObject({duplicate:true,eventId:first.eventId});
    const event=store.dueSkillExtractions()[0];
    expect(event.messages.map((message)=>message.role)).toEqual(["user","tool_call","tool_result","assistant"]);
    expect(event.messages[1]).toMatchObject({tool_call_id:"call-1",tool_name:"Bash"});
    expect(event.messages[1].content).not.toContain("secret");
    expect(()=>JSON.parse(event.messages[1].content)).not.toThrow();
    expect(()=>JSON.parse(event.messages[2].content)).not.toThrow();
  });
  it("bounds a very long tool trace without splitting tool pairs",()=>{const store=new GatewayStore(join(mkdtempSync(join(tmpdir(),"skill-limit-test-")),"db.sqlite"));const ctx=store.openContext({id:"p",token:"x",userId:"u"},{teamId:"t",userId:"u",agentId:"a"},{host:"codex",sessionId:"s",workspace:"/repo"},60000);store.beginTurn(ctx.contextId,"turn","work");for(let i=0;i<300;i++)store.recordToolUse(ctx.contextId,"turn",`call-${i}`,"Bash",{i},{ok:true});store.enqueueCapture(ctx.contextId,"turn","done");store.enqueueSkillExtraction(ctx.contextId,"complete");const messages=store.dueSkillExtractions()[0].messages;expect(messages).toHaveLength(500);expect(messages[0].role).toBe("user");expect(messages.at(-1)?.role).toBe("assistant");for(let i=1;i<messages.length-1;i+=2){expect(messages[i].role).toBe("tool_call");expect(messages[i+1].role).toBe("tool_result");expect(messages[i].tool_call_id).toBe(messages[i+1].tool_call_id)}});
  it("keeps oversized sanitized tool payloads as valid JSON",()=>{const store=new GatewayStore(join(mkdtempSync(join(tmpdir(),"tool-json-test-")),"db.sqlite"));const ctx=store.openContext({id:"p",token:"x",userId:"u"},{teamId:"t",userId:"u",agentId:"a"},{host:"codex",sessionId:"s",workspace:"/repo"},60000);store.beginTurn(ctx.contextId,"turn","work");store.recordToolUse(ctx.contextId,"turn","call","Bash",{output:"x".repeat(50000)},{output:"y".repeat(50000)});store.enqueueCapture(ctx.contextId,"turn","done");store.enqueueSkillExtraction(ctx.contextId,"complete");const messages=store.dueSkillExtractions()[0].messages;expect(JSON.parse(messages[1].content)).toMatchObject({truncated:true});expect(JSON.parse(messages[2].content)).toMatchObject({truncated:true})});
  it("holds SessionEnd extraction until the detached Stop delivery window closes",()=>{const store=new GatewayStore(join(mkdtempSync(join(tmpdir(),"skill-settle-test-")),"db.sqlite"));const ctx=store.openContext({id:"p",token:"x",userId:"u"},{teamId:"t",userId:"u",agentId:"a"},{host:"codex",sessionId:"s",workspace:"/repo"},60000);store.enqueueSkillExtraction(ctx.contextId,"complete",5000);expect(store.pendingSkillExtractionCount()).toBe(1);expect(store.dueSkillExtractions()).toEqual([])});
  it("extends the extraction settle window when a late hook arrives",async()=>{const store=new GatewayStore(join(mkdtempSync(join(tmpdir(),"skill-touch-test-")),"db.sqlite"));const ctx=store.openContext({id:"p",token:"x",userId:"u"},{teamId:"t",userId:"u",agentId:"a"},{host:"codex",sessionId:"s",workspace:"/repo"},60000);store.enqueueSkillExtraction(ctx.contextId,"complete",1);store.touchSkillExtraction(ctx.contextId,5000);await new Promise((resolve)=>setTimeout(resolve,10));expect(store.dueSkillExtractions()).toEqual([])});
  it("retains an expired context while asynchronous capture is pending",async()=>{const store=new GatewayStore(join(mkdtempSync(join(tmpdir(),"context-retain-test-")),"db.sqlite"));const ctx=store.openContext({id:"p",token:"x",userId:"u"},{teamId:"t",userId:"u",agentId:"a"},{host:"codex",sessionId:"s",workspace:"/repo"},1);store.beginTurn(ctx.contextId,"turn","remember this");store.enqueueCapture(ctx.contextId,"turn","done");await new Promise((resolve)=>setTimeout(resolve,10));store.prune();expect(store.getContextForWorker(ctx.contextId)).not.toBeNull()});
});
