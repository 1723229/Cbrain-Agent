export interface KnowledgeClientOptions {
  baseUrl: string;
  serviceId: string;
  token?: string;
  timeoutMs: number;
  fetcher?: typeof fetch;
}

export class KnowledgeClient {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: KnowledgeClientOptions) {
    if (!options.serviceId.trim()) throw new Error("Knowledge serviceId is required");
    this.baseUrl = options.baseUrl.replace(/\/+$/, "").replace(/\/v3$/, "");
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async callTool(knowledgeId: string, toolName: string, params: Record<string, unknown>): Promise<unknown> {
    const headers: Record<string, string> = { "Content-Type": "application/json", "x-tdai-service-id": this.options.serviceId };
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    const response = await this.fetcher(`${this.baseUrl}/v3/tools/call`, {
      method: "POST", headers,
      body: JSON.stringify({ knowledge_id: knowledgeId, tool_name: toolName, params }),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    const envelope = await response.json().catch(() => null) as { code?: number; message?: string; data?: unknown } | null;
    if (!response.ok || !envelope || envelope.code !== 0) throw new Error(envelope?.message || `Knowledge request failed (HTTP ${response.status})`);
    return envelope.data;
  }
}
