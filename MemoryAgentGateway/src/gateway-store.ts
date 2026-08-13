import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentIdentity, ConversationMessage, GatewayPrincipal, SessionContext } from "./types.js";

export interface CaptureEvent {
  eventId: string;
  contextId: string;
  user: string;
  assistant: string;
  coreStatus: "pending" | "done" | "dead";
  skillStatus: "pending" | "done" | "dead";
  attempts: number;
}

export interface SkillExtractionEvent {
  eventId: string;
  contextId: string;
  reason: string;
  messages: ConversationMessage[];
  attempts: number;
}

export interface WorkspaceBinding {
  principalId: string;
  workspaceKey: string;
  workspaceLabel: string;
  teamId: string;
  agentId: string;
  agentName?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceBindingRequest {
  requestId: string;
  principalId: string;
  workspaceKey: string;
  workspaceLabel: string;
  host: string;
  sessionId: string;
  workspace: string;
  createdAt: number;
  expiresAt: number;
}

export class GatewayStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS session_contexts (
        context_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, team_id TEXT NOT NULL,
        user_id TEXT NOT NULL, user_key TEXT, agent_id TEXT NOT NULL, agent_name TEXT,
        host TEXT NOT NULL, session_id TEXT NOT NULL, workspace TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_context_lookup ON session_contexts(principal_id, host, session_id, workspace);
      CREATE TABLE IF NOT EXISTS pending_turns (
        context_id TEXT NOT NULL, turn_id TEXT NOT NULL, prompt TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(context_id, turn_id)
      );
      CREATE TABLE IF NOT EXISTS capture_events (
        event_id TEXT PRIMARY KEY, context_id TEXT NOT NULL, turn_id TEXT NOT NULL DEFAULT 'current', user_text TEXT NOT NULL, assistant_text TEXT NOT NULL,
        core_status TEXT NOT NULL DEFAULT 'pending', skill_status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, last_error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_capture_pending ON capture_events(next_attempt_at, core_status, skill_status);
      CREATE TABLE IF NOT EXISTS tool_events (
        event_id TEXT PRIMARY KEY, context_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        tool_use_id TEXT NOT NULL, tool_name TEXT NOT NULL, input_json TEXT NOT NULL,
        response_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tool_context_turn ON tool_events(context_id, turn_id, created_at);
      CREATE TABLE IF NOT EXISTS skill_extraction_events (
        event_id TEXT PRIMARY KEY, context_id TEXT NOT NULL, reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', task_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
        last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_skill_extract_pending ON skill_extraction_events(next_attempt_at, status);
      CREATE TABLE IF NOT EXISTS workspace_bindings (
        principal_id TEXT NOT NULL, workspace_key TEXT NOT NULL, workspace_label TEXT NOT NULL,
        team_id TEXT NOT NULL, agent_id TEXT NOT NULL, agent_name TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(principal_id, workspace_key)
      );
      CREATE TABLE IF NOT EXISTS workspace_binding_requests (
        request_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, workspace_key TEXT NOT NULL,
        workspace_label TEXT NOT NULL, host TEXT NOT NULL, session_id TEXT NOT NULL,
        workspace TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_binding_requests ON workspace_binding_requests(principal_id, workspace_key, expires_at);
    `);
    this.ensureColumn("capture_events", "turn_id", "TEXT NOT NULL DEFAULT 'current'");
    this.db.exec("UPDATE session_contexts SET user_key=NULL WHERE user_key IS NOT NULL");
  }

  openContext(principal: GatewayPrincipal, identity: AgentIdentity, input: { host: string; sessionId: string; workspace: string }, ttlMs: number): SessionContext {
    const now = Date.now();
    const existing = this.db.prepare(`SELECT * FROM session_contexts WHERE principal_id=? AND host=? AND session_id=? AND workspace=? AND team_id=? AND agent_id=? AND expires_at>? ORDER BY created_at DESC LIMIT 1`)
      .get(principal.id, input.host, input.sessionId, input.workspace, identity.teamId, identity.agentId, now) as ContextRow | undefined;
    if (existing) return fromContextRow(existing);
    const context: SessionContext = { ...identity, contextId: randomUUID(), principalId: principal.id, host: input.host, sessionId: input.sessionId, workspace: input.workspace, createdAt: now, expiresAt: now + ttlMs };
    delete context.userKey;
    this.db.prepare(`INSERT INTO session_contexts(context_id,principal_id,team_id,user_id,user_key,agent_id,agent_name,host,session_id,workspace,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(context.contextId, context.principalId, context.teamId, context.userId, null, context.agentId, context.agentName ?? null, context.host, context.sessionId, context.workspace, context.createdAt, context.expiresAt);
    return context;
  }

  getContext(contextId: string, principalId: string): SessionContext | null {
    const row = this.db.prepare("SELECT * FROM session_contexts WHERE context_id=? AND principal_id=? AND expires_at>?").get(contextId, principalId, Date.now()) as ContextRow | undefined;
    return row ? fromContextRow(row) : null;
  }

  getContextForWorker(contextId: string): SessionContext | null {
    const row = this.db.prepare("SELECT * FROM session_contexts WHERE context_id=?").get(contextId) as ContextRow | undefined;
    return row ? fromContextRow(row) : null;
  }

  getWorkspaceBinding(principalId: string, workspaceKey: string): WorkspaceBinding | null {
    const row = this.db.prepare("SELECT * FROM workspace_bindings WHERE principal_id=? AND workspace_key=?")
      .get(principalId, workspaceKey) as WorkspaceBindingRow | undefined;
    return row ? fromWorkspaceBindingRow(row) : null;
  }

  removeWorkspaceBinding(principalId: string, workspaceKey: string): boolean {
    const removed=this.db.prepare("DELETE FROM workspace_bindings WHERE principal_id=? AND workspace_key=?").run(principalId, workspaceKey).changes > 0;
    this.db.prepare("DELETE FROM workspace_binding_requests WHERE principal_id=? AND workspace_key=?").run(principalId,workspaceKey);
    return removed;
  }

  issueWorkspaceBindingRequest(
    principalId: string,
    input: { workspaceKey: string; workspaceLabel: string; host: string; sessionId: string; workspace: string },
    ttlMs: number,
  ): WorkspaceBindingRequest {
    const now = Date.now();
    const existing = this.db.prepare(`SELECT * FROM workspace_binding_requests
      WHERE principal_id=? AND workspace_key=? AND host=? AND session_id=? AND workspace=? AND expires_at>?
      ORDER BY created_at DESC LIMIT 1`)
      .get(principalId, input.workspaceKey, input.host, input.sessionId, input.workspace, now) as WorkspaceBindingRequestRow | undefined;
    if (existing) return fromWorkspaceBindingRequestRow(existing);
    const request: WorkspaceBindingRequest = {
      requestId: randomUUID(), principalId, ...input, createdAt: now, expiresAt: now + ttlMs,
    };
    this.db.prepare(`INSERT INTO workspace_binding_requests(
      request_id,principal_id,workspace_key,workspace_label,host,session_id,workspace,created_at,expires_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      request.requestId, request.principalId, request.workspaceKey, request.workspaceLabel,
      request.host, request.sessionId, request.workspace, request.createdAt, request.expiresAt,
    );
    return request;
  }

  completeWorkspaceBinding(requestId: string, principalId: string, identity: AgentIdentity): { request: WorkspaceBindingRequest; binding: WorkspaceBinding } {
    const row = this.db.prepare("SELECT * FROM workspace_binding_requests WHERE request_id=? AND principal_id=? AND expires_at>?")
      .get(requestId, principalId, Date.now()) as WorkspaceBindingRequestRow | undefined;
    if (!row) throw new Error("binding request is invalid or expired");
    const request = fromWorkspaceBindingRequestRow(row);
    const now = Date.now();
    this.db.prepare(`INSERT INTO workspace_bindings(
      principal_id,workspace_key,workspace_label,team_id,agent_id,agent_name,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(principal_id,workspace_key) DO UPDATE SET
      workspace_label=excluded.workspace_label,team_id=excluded.team_id,agent_id=excluded.agent_id,
      agent_name=excluded.agent_name,updated_at=excluded.updated_at`).run(
      principalId, request.workspaceKey, request.workspaceLabel, identity.teamId, identity.agentId,
      identity.agentName ?? null, now, now,
    );
    return { request, binding: this.getWorkspaceBinding(principalId, request.workspaceKey)! };
  }

  beginTurn(contextId: string, turnId: string, prompt: string): void {
    this.db.prepare(`INSERT INTO pending_turns(context_id,turn_id,prompt,updated_at) VALUES(?,?,?,?) ON CONFLICT(context_id,turn_id) DO UPDATE SET prompt=excluded.prompt,updated_at=excluded.updated_at`)
      .run(contextId, turnId, prompt, Date.now());
  }

  enqueueCapture(contextId: string, turnId: string, assistant: string, suppliedPrompt?: string): { eventId: string; duplicate: boolean } {
    const pending = this.db.prepare("SELECT prompt FROM pending_turns WHERE context_id=? AND turn_id=?").get(contextId, turnId) as { prompt: string } | undefined;
    const user = suppliedPrompt?.trim() || pending?.prompt;
    if (!user) throw new Error("prompt is unavailable for this completed turn");
    const eventId = createHash("sha256").update(`${contextId}\0${turnId}\0${user}\0${assistant}`).digest("hex");
    const now = Date.now();
    const result = this.db.prepare(`INSERT OR IGNORE INTO capture_events(event_id,context_id,turn_id,user_text,assistant_text,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(eventId, contextId, turnId, user, assistant, now, now, now);
    this.db.prepare("DELETE FROM pending_turns WHERE context_id=? AND turn_id=?").run(contextId, turnId);
    return { eventId, duplicate: result.changes === 0 };
  }

  recordToolUse(contextId: string, turnId: string, toolUseId: string, toolName: string, input: unknown, response: unknown): { eventId: string; duplicate: boolean } {
    const eventId = createHash("sha256").update(`${contextId}\0${turnId}\0${toolUseId}`).digest("hex");
    const result = this.db.prepare(`INSERT OR IGNORE INTO tool_events(event_id,context_id,turn_id,tool_use_id,tool_name,input_json,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(eventId, contextId, turnId, toolUseId, toolName.slice(0, 256), safeJson(input), safeJson(response), Date.now());
    return { eventId, duplicate: result.changes === 0 };
  }

  enqueueSkillExtraction(contextId: string, reason: string, delayMs = 0): { eventId: string; duplicate: boolean } {
    const context = this.getContextForWorker(contextId);
    if (!context) throw new Error("session context is unavailable");
    const eventId = createHash("sha256").update(`${contextId}\0${context.sessionId}\0skill-extract`).digest("hex");
    const now = Date.now();
    const result = this.db.prepare(`INSERT OR IGNORE INTO skill_extraction_events(event_id,context_id,reason,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
      .run(eventId, contextId, reason.slice(0, 500), now + Math.max(0, delayMs), now, now);
    return { eventId, duplicate: result.changes === 0 };
  }

  dueSkillExtractions(limit = 10): SkillExtractionEvent[] {
    const rows = this.db.prepare(`SELECT event_id,context_id,reason,attempts FROM skill_extraction_events WHERE status='pending' AND next_attempt_at<=? ORDER BY created_at LIMIT ?`)
      .all(Date.now(), limit) as unknown as SkillExtractionRow[];
    return rows.map((row) => ({ eventId: row.event_id, contextId: row.context_id, reason: row.reason, attempts: row.attempts, messages: this.skillTranscript(row.context_id) }));
  }

  markSkillExtractionSubmitted(eventId: string, taskId?: string): void {
    this.db.prepare("UPDATE skill_extraction_events SET status='submitted',task_id=?,last_error=NULL,updated_at=? WHERE event_id=?").run(taskId ?? null, Date.now(), eventId);
  }

  markSkillExtractionSkipped(eventId: string, reason: string): void {
    this.db.prepare("UPDATE skill_extraction_events SET status='skipped',last_error=?,updated_at=? WHERE event_id=?").run(reason.slice(0, 1000), Date.now(), eventId);
  }

  markSkillExtractionRetry(eventId: string, attempts: number, error: string): void {
    const delay = Math.min(5 * 60_000, 1000 * 2 ** Math.min(attempts, 8));
    this.db.prepare("UPDATE skill_extraction_events SET attempts=?,next_attempt_at=?,last_error=?,updated_at=? WHERE event_id=?")
      .run(attempts, Date.now() + delay, error.slice(0, 1000), Date.now(), eventId);
  }
  markSkillExtractionDead(eventId:string,error:string):void{this.db.prepare("UPDATE skill_extraction_events SET status='dead',last_error=?,updated_at=? WHERE event_id=?").run(error.slice(0,1000),Date.now(),eventId)}
  touchSkillExtraction(contextId:string,delayMs:number):void{const due=Date.now()+Math.max(0,delayMs);this.db.prepare("UPDATE skill_extraction_events SET next_attempt_at=MAX(next_attempt_at,?),updated_at=? WHERE context_id=? AND status='pending'").run(due,Date.now(),contextId)}

  pendingSkillExtractionCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM skill_extraction_events WHERE status='pending'").get() as { count: number }).count);
  }

  latestSkillExtraction(contextId: string): { status: string; taskId?: string; attempts: number; lastError?: string } | null {
    const row = this.db.prepare("SELECT status,task_id,attempts,last_error FROM skill_extraction_events WHERE context_id=? ORDER BY created_at DESC LIMIT 1").get(contextId) as { status:string;task_id:string|null;attempts:number;last_error:string|null }|undefined;
    return row ? { status: row.status, taskId: row.task_id ?? undefined, attempts: row.attempts, lastError: row.last_error ?? undefined } : null;
  }

  dueCaptures(limit = 20): CaptureEvent[] {
    const rows = this.db.prepare(`SELECT event_id,context_id,user_text,assistant_text,core_status,skill_status,attempts FROM capture_events WHERE (core_status='pending' OR skill_status='pending') AND next_attempt_at<=? ORDER BY created_at LIMIT ?`)
      .all(Date.now(), limit) as unknown as CaptureRow[];
    return rows.map((row) => ({ eventId: row.event_id, contextId: row.context_id, user: row.user_text, assistant: row.assistant_text, coreStatus: row.core_status, skillStatus: row.skill_status, attempts: row.attempts }));
  }

  markSink(eventId: string, sink: "core" | "skill"): void { this.db.prepare(`UPDATE capture_events SET ${sink}_status='done',updated_at=? WHERE event_id=?`).run(Date.now(), eventId); }
  markDeadSink(eventId:string,sink:"core"|"skill",error:string):void{this.db.prepare(`UPDATE capture_events SET ${sink}_status='dead',last_error=?,updated_at=? WHERE event_id=?`).run(error.slice(0,1000),Date.now(),eventId)}
  markRetry(eventId: string, attempts: number, error: string): void {
    const delay = Math.min(5 * 60_000, 1000 * 2 ** Math.min(attempts, 8));
    this.db.prepare("UPDATE capture_events SET attempts=?,next_attempt_at=?,last_error=?,updated_at=? WHERE event_id=?").run(attempts, Date.now() + delay, error.slice(0, 1000), Date.now(), eventId);
  }
  pendingCaptureCount(): number { return Number((this.db.prepare("SELECT COUNT(*) AS count FROM capture_events WHERE core_status='pending' OR skill_status='pending'").get() as { count: number }).count); }
  deadCaptureCount():number{return Number((this.db.prepare("SELECT COUNT(*) count FROM capture_events WHERE core_status='dead' OR skill_status='dead'").get() as {count:number}).count)}
  deadSkillExtractionCount():number{return Number((this.db.prepare("SELECT COUNT(*) count FROM skill_extraction_events WHERE status='dead'").get() as {count:number}).count)}
  oldestPendingAgeMs():number{const capture=this.db.prepare("SELECT MIN(created_at) oldest FROM capture_events WHERE core_status='pending' OR skill_status='pending'").get() as {oldest:number|null};const skill=this.db.prepare("SELECT MIN(created_at) oldest FROM skill_extraction_events WHERE status='pending'").get() as {oldest:number|null};const oldest=Math.min(...[capture.oldest,skill.oldest].filter((value):value is number=>typeof value==="number"));return Number.isFinite(oldest)?Math.max(0,Date.now()-oldest):0}
  prune(): void {
    const now = Date.now();
    this.db.prepare("DELETE FROM pending_turns WHERE updated_at<?").run(now - 24 * 60 * 60_000);
    this.db.prepare(`DELETE FROM session_contexts WHERE expires_at<?
      AND NOT EXISTS(SELECT 1 FROM capture_events WHERE capture_events.context_id=session_contexts.context_id AND (core_status='pending' OR skill_status='pending'))
      AND NOT EXISTS(SELECT 1 FROM skill_extraction_events WHERE skill_extraction_events.context_id=session_contexts.context_id AND status='pending')`).run(now);
    this.db.prepare("DELETE FROM capture_events WHERE core_status!='pending' AND skill_status!='pending' AND updated_at<?").run(now - 7 * 24 * 60 * 60_000);
    this.db.prepare("DELETE FROM tool_events WHERE created_at<?").run(now - 7 * 24 * 60 * 60_000);
    this.db.prepare("DELETE FROM skill_extraction_events WHERE status IN ('submitted','skipped','dead') AND updated_at<?").run(now - 7 * 24 * 60 * 60_000);
    this.db.prepare("DELETE FROM workspace_binding_requests WHERE expires_at<?").run(now);
  }


  private skillTranscript(contextId: string): ConversationMessage[] {
    const turns = this.db.prepare("SELECT turn_id,user_text,assistant_text FROM capture_events WHERE context_id=? ORDER BY created_at,event_id").all(contextId) as unknown as Array<{turn_id:string;user_text:string;assistant_text:string}>;
    const bundles: ConversationMessage[][] = [];
    for (const turn of turns) {
      const bundle: ConversationMessage[] = [{ role: "user", content: boundedWorkText(turn.user_text) }];
      let tools = this.db.prepare("SELECT tool_use_id,tool_name,input_json,response_json FROM tool_events WHERE context_id=? AND turn_id=? ORDER BY created_at,event_id").all(contextId, turn.turn_id) as unknown as Array<{tool_use_id:string;tool_name:string;input_json:string;response_json:string}>;
      if (tools.length > 249) tools = tools.slice(-249);
      for (const tool of tools) {
        bundle.push({ role: "tool_call", content: tool.input_json, tool_name: tool.tool_name, tool_call_id: tool.tool_use_id });
        bundle.push({ role: "tool_result", content: tool.response_json, tool_name: tool.tool_name, tool_call_id: tool.tool_use_id });
      }
      bundle.push({ role: "assistant", content: boundedWorkText(turn.assistant_text) });bundles.push(bundle);
    }
    const messages: ConversationMessage[] = [];
    for (let i=bundles.length-1;i>=0;i--){const bundle=bundles[i]!;if(messages.length&&messages.length+bundle.length>500)break;messages.unshift(...bundle);if(messages.length>=500)break}
    return messages;
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{name:string}>;
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

interface ContextRow { context_id:string;principal_id:string;team_id:string;user_id:string;user_key:string|null;agent_id:string;agent_name:string|null;host:string;session_id:string;workspace:string;created_at:number;expires_at:number }
interface CaptureRow { event_id:string;context_id:string;user_text:string;assistant_text:string;core_status:"pending"|"done"|"dead";skill_status:"pending"|"done"|"dead";attempts:number }
interface SkillExtractionRow { event_id:string;context_id:string;reason:string;attempts:number }
interface WorkspaceBindingRow { principal_id:string;workspace_key:string;workspace_label:string;team_id:string;agent_id:string;agent_name:string|null;created_at:number;updated_at:number }
interface WorkspaceBindingRequestRow { request_id:string;principal_id:string;workspace_key:string;workspace_label:string;host:string;session_id:string;workspace:string;created_at:number;expires_at:number }
function fromContextRow(row: ContextRow): SessionContext { return { contextId:row.context_id,principalId:row.principal_id,teamId:row.team_id,userId:row.user_id,userKey:row.user_key??undefined,agentId:row.agent_id,agentName:row.agent_name??undefined,host:row.host,sessionId:row.session_id,workspace:row.workspace,createdAt:row.created_at,expiresAt:row.expires_at }; }
function fromWorkspaceBindingRow(row: WorkspaceBindingRow): WorkspaceBinding { return { principalId:row.principal_id,workspaceKey:row.workspace_key,workspaceLabel:row.workspace_label,teamId:row.team_id,agentId:row.agent_id,agentName:row.agent_name??undefined,createdAt:row.created_at,updatedAt:row.updated_at }; }
function fromWorkspaceBindingRequestRow(row: WorkspaceBindingRequestRow): WorkspaceBindingRequest { return { requestId:row.request_id,principalId:row.principal_id,workspaceKey:row.workspace_key,workspaceLabel:row.workspace_label,host:row.host,sessionId:row.session_id,workspace:row.workspace,createdAt:row.created_at,expiresAt:row.expires_at }; }

const SENSITIVE_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key)/i;
function safeJson(value: unknown): string {
  const sanitized = sanitize(value, 0);
  const json = JSON.stringify(sanitized) ?? "null";
  if (json.length <= 16_000) return json;
  return JSON.stringify({ truncated: true, preview: boundedWorkText(json).slice(0, 16_000) });
}
function sanitize(value: unknown, depth: number): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return value.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]").slice(0, 16_000);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key,item]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitize(item, depth + 1)]));
  return value;
}
function boundedWorkText(value:string):string{return value.length<=32_000?value:`${value.slice(0,16_000)}\n...[truncated]...\n${value.slice(-16_000)}`}
