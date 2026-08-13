import type { AgentIdentity, ConversationMessage, CoreClientConfig, GatewayPrincipal, KnowledgeResource, SessionIdentity } from "./types.js";

interface Envelope<T> { code: number; message?: string; data?: T }
export interface SearchItem { content?: string; score?: number; [key: string]: unknown }
export interface SearchData { items?: SearchItem[]; messages?: SearchItem[] }
export interface SceneData { entries?: Array<{ path: string; summary?: string }>; total?: number }
export interface SceneFile { path?: string; content?: string; [key: string]: unknown }
interface FixedAssetDetail { agent?: { prompt?: string | null }; items?: Array<{ asset_id: string; asset_type: string; status?: string }> }
interface AgentRecord { agent_id: string; team_id: string; owner_user_id: string; name: string; prompt?: string | null; status: string }
interface AuthVerification { valid: boolean; user: { user_id?: string } | null }

export class UpstreamRequestError extends Error { constructor(message:string,readonly status:number,readonly retryable:boolean){super(message)} }
export class AgentBindingInvalidError extends Error {}

export class CoreClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly config: CoreClientConfig, readonly identity: SessionIdentity, fetcher?: typeof fetch) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "").replace(/\/v3$/, "");
    this.fetcher = fetcher ?? globalThis.fetch.bind(globalThis);
  }

  searchMemory(query: string, limit = 5, type?: string, timeoutMs?: number): Promise<SearchData> { return this.postData("/atomic/search", { query, limit, ...(type ? { type } : {}) }, timeoutMs); }
  searchConversation(query: string, limit = 5, sessionId?: string): Promise<SearchData> { return this.postData("/conversation/search", { query, limit, ...(sessionId ? { session_id: sessionId } : {}) }); }
  listScenes(pathPrefix = "", timeoutMs?: number): Promise<SceneData> { return this.postData("/scenario/ls", { path_prefix: pathPrefix }, timeoutMs); }
  readScene(path: string): Promise<SceneFile | null> { return this.postData("/scenario/read", { path }); }
  readProfile(timeoutMs?: number): Promise<SceneFile | null> { return this.postData("/core/read", {}, timeoutMs); }
  addConversation(messages: ConversationMessage[]): Promise<unknown> { return this.postData("/conversation/add", { messages, session_id: this.identity.sessionId }); }
  addSkillConversation(messages: ConversationMessage[]): Promise<unknown> { return this.postData("/skill/conversation/add", { messages, session_id: this.identity.sessionId }); }
  extractSkill(messages: ConversationMessage[], reason: string): Promise<{ ok?: boolean; task_id?: string }> { return this.postData("/skill/extract", { messages, session_id: this.identity.sessionId, reason }); }

  listSkills(limit = 50, offset = 0): Promise<unknown> { return this.postData("/skill/list", { limit, offset }); }
  searchSkills(query: string, topK = 10): Promise<unknown> { return this.postData("/skill/search", { query, top_k: topK }); }
  getSkill(skillId: string, version?: number): Promise<unknown> { return this.postData("/skill/get", { skill_id: skillId, include_content: true, include_manifest: true, ...(version ? { version } : {}) }); }
  readSkillFile(skillId: string, path: string, version?: number, encoding?: string): Promise<unknown> { return this.postData("/skill/files/read", { skill_id: skillId, path, ...(version ? { version } : {}), ...(encoding ? { encoding } : {}) }); }
  skillListing(query = "", charBudget = 8_000, timeoutMs?:number): Promise<unknown> { return this.postData("/skill/listing", { ...(query ? { query } : {}), char_budget: charBudget },timeoutMs); }

  async agentAndAssets(timeoutMs?:number): Promise<FixedAssetDetail> {
    return this.postMeta("/agent-fixed-asset/list-with-detail", { agent_id: this.identity.agentId, apply_visibility_filter: false, touch_usage: false }, this.identity.userKey,timeoutMs);
  }

  async listBoundKnowledge(configuredIds: readonly string[],fixedDetail?:FixedAssetDetail,timeoutMs?:number): Promise<KnowledgeResource[]> {
    let ids = [...new Set(configuredIds.filter(Boolean))];
    const [fixed,accessible]=await Promise.all([fixedDetail??this.agentAndAssets(timeoutMs),this.listAccessibleAssetIds(timeoutMs)]);
    const bound = new Set((fixed.items ?? [])
      .filter((item) => item.asset_type === "llm_wiki" || item.asset_type === "code_graph")
      .filter((item) => !["archived", "deprecated", "failed"].includes(item.status ?? ""))
      .map((item) => item.asset_id));
    const allowed = new Set(accessible);
    if (ids.length === 0) {
      ids = [...bound].filter((assetId) => allowed.has(assetId));
    } else ids = ids.filter((assetId) => bound.has(assetId) && allowed.has(assetId));
    if (ids.length === 0) return [];
    const result = await this.postData<{ items?: KnowledgeResource[] }>("/knowledge/list", { team_id: this.identity.teamId, knowledge_ids: ids },timeoutMs);
    return result.items ?? [];
  }

  private async listAccessibleAssetIds(timeoutMs?:number): Promise<string[]> {
    const ids: string[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await this.postMeta<{ items?: Array<{ asset_id: string }>; total?: number }>("/asset/list-accessible", {
        user_id: this.identity.userId, team_id: this.identity.teamId, agent_id: this.identity.agentId, action: "read", limit: 100, offset,
      }, this.identity.userKey,timeoutMs);
      const items = page.items ?? []; ids.push(...items.map((item) => item.asset_id));
      if (items.length < 100 || ids.length >= (page.total ?? ids.length)) break;
    }
    return ids;
  }

  private postData<T>(path: string, body: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    return this.post<T>(path, {
      team_id: this.identity.teamId, user_id: this.identity.userId, agent_id: this.identity.agentId,
      ...(this.identity.taskId ? { task_id: this.identity.taskId } : {}), ...body,
    }, this.identity.userKey, timeoutMs);
  }

  private postMeta<T>(path: string, body: Record<string, unknown>, userKey?: string,timeoutMs?:number): Promise<T> { return this.post<T>(`/meta${path}`, body, userKey,timeoutMs); }

  private async post<T>(path: string, body: Record<string, unknown>, userKey?: string, timeoutMs = this.config.timeoutMs): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json", "x-tdai-service-id": this.config.serviceId,
      "x-tdai-team-id": this.identity.teamId, "x-tdai-user-id": this.identity.userId,
      "x-tdai-agent-id": this.identity.agentId, "x-tdai-session-id": this.identity.sessionId,
    };
    if (userKey) headers["x-tdai-user-key"] = userKey;
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
    const response = await this.fetcher(`${this.baseUrl}/v3${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const envelope = await response.json().catch(() => null) as Envelope<T> | null;
    if (!response.ok || !envelope || envelope.code !== 0) throw new UpstreamRequestError(envelope?.message || `Core request failed (HTTP ${response.status})`,response.status,response.status===408||response.status===429||response.status>=500);
    return envelope.data as T;
  }
}

export class CoreDirectoryClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  constructor(private readonly config: CoreClientConfig, fetcher?: typeof fetch) { this.baseUrl = config.baseUrl.replace(/\/+$/, "").replace(/\/v3$/, ""); this.fetcher = fetcher ?? globalThis.fetch.bind(globalThis); }

  async verifyUserKey(userKey: string): Promise<string | null> {
    const headers: Record<string, string> = { "Content-Type": "application/json", "x-tdai-service-id": this.config.serviceId };
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
    const response = await this.fetcher(`${this.baseUrl}/v3/meta/auth/verify`, {
      method: "POST", headers, body: JSON.stringify({ user_key: userKey }), signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    const envelope = await response.json().catch(() => null) as Envelope<AuthVerification> | null;
    if (!response.ok || !envelope || envelope.code !== 0) throw new UpstreamRequestError(envelope?.message || `Core authentication failed (HTTP ${response.status})`, response.status, response.status === 408 || response.status === 429 || response.status >= 500);
    const userId = envelope.data?.valid ? envelope.data.user?.user_id?.trim() : "";
    return userId || null;
  }

  async options(principal: GatewayPrincipal): Promise<unknown> {
    const [teams,agents]=await Promise.all([this.metaPages("/team/list", identityField(principal), principal),this.metaPages("/agent/list", principal.userKey ? { owner_user_key: principal.userKey } : { owner_user_id: principal.userId }, principal)]);
    return { teams, agents };
  }

  private async metaPages(path: string, body: Record<string, unknown>, principal: GatewayPrincipal): Promise<unknown[]> {
    const all: unknown[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await this.meta<{ items?: unknown[]; total?: number }>(path, { ...body, limit: 100, offset }, principal);
      const items = page.items ?? []; all.push(...items);
      if (items.length < 100 || all.length >= (page.total ?? all.length)) break;
    }
    return all;
  }

  async validate(principal: GatewayPrincipal, teamId: string, agentId: string): Promise<{ identity: AgentIdentity; agent: AgentRecord }> {
    const agent = await this.meta<AgentRecord>("/agent/get", { agent_id: agentId }, principal);
    if (!agent || agent.team_id !== teamId || agent.owner_user_id !== principal.userId || agent.status !== "active") throw new AgentBindingInvalidError("agent is not an active user-owned agent in this team");
    return { identity: { teamId, userId: principal.userId, userKey: principal.userKey, agentId, agentName: agent.name }, agent };
  }

  private async meta<T>(path: string, body: Record<string, unknown>, principal: GatewayPrincipal): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json", "x-tdai-service-id": this.config.serviceId };
    if (principal.userKey) headers["x-tdai-user-key"] = principal.userKey;
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
    const response = await this.fetcher(`${this.baseUrl}/v3/meta${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.config.timeoutMs) });
    const envelope = await response.json().catch(() => null) as Envelope<T> | null;
    if (!response.ok || !envelope || envelope.code !== 0) throw new UpstreamRequestError(envelope?.message || `Core metadata request failed (HTTP ${response.status})`,response.status,response.status===408||response.status===429||response.status>=500);
    return envelope.data as T;
  }
}

function identityField(principal: GatewayPrincipal): Record<string, unknown> { return principal.userKey ? { user_key: principal.userKey } : { user_id: principal.userId }; }
