export interface AgentIdentity {
  teamId: string;
  userId: string;
  agentId: string;
  userKey?: string;
  agentName?: string;
}

export interface SessionIdentity extends AgentIdentity {
  sessionId: string;
  taskId?: string;
}

export interface GatewayPrincipal {
  id: string;
  userId: string;
  userKey?: string;
}

export interface CoreClientConfig {
  baseUrl: string;
  serviceId: string;
  token?: string;
  timeoutMs: number;
}

export interface SessionContext extends SessionIdentity {
  contextId: string;
  principalId: string;
  host: string;
  workspace: string;
  createdAt: number;
  expiresAt: number;
}

export interface KnowledgeResource {
  knowledge_id: string;
  type: "wiki" | "code-graph" | string;
  service_url?: string;
  name: string;
  summary?: string | null;
  status?: string;
  repo_url?: string;
  branch?: string;
  [key: string]: unknown;
}

export interface ConversationMessage {
  role: "user" | "assistant" | "tool_call" | "tool_result" | "system";
  content: string;
  timestamp?: string;
  tool_name?: string;
  tool_call_id?: string;
}
