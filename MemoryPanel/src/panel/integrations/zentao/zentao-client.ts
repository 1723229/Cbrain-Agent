export interface ZentaoSyncMember {
  external_id: string;
  account: string;
  role: "member";
}

export interface ZentaoSyncProject {
  external_id: string;
  name: string;
  code: string;
  description: string | null;
  status: string;
  pm_account: string | null;
  members: ZentaoSyncMember[];
  metadata_json: string;
}

export interface ZentaoSyncSnapshot {
  provider_id: string;
  identity_provider_id: string;
  source_url: string;
  captured_at: string;
  complete: true;
  projects: ZentaoSyncProject[];
}

export interface ZentaoClientOptions {
  baseUrl: string;
  account: string;
  passwordProvider: () => string | Promise<string>;
  identityProviderId: string;
  providerId?: string;
  timeoutMs?: number;
  memberConcurrency?: number;
  fetchFn?: typeof fetch;
}

interface ProjectRow {
  id: number | string;
  name?: string;
  code?: string;
  status?: string;
  PM?: string;
  desc?: string;
  deleted?: boolean | string;
  model?: string;
}

interface MemberRow {
  id?: number | string;
  account?: string;
}

function plainText(html: string | undefined): string | null {
  if (!html) return null;
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .trim();
  return text || null;
}

function isClosed(project: ProjectRow): boolean {
  return project.deleted === true || project.deleted === "1" || project.status === "closed";
}

export class ZentaoClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly memberConcurrency: number;
  private token: string | null = null;

  constructor(private readonly options: ZentaoClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.memberConcurrency = Math.max(1, options.memberConcurrency ?? 5);
  }

  async fetchSnapshot(): Promise<ZentaoSyncSnapshot> {
    const rows = await this.fetchAllProjects();
    const projects: ZentaoSyncProject[] = rows.map((row) => ({
      external_id: String(row.id),
      name: row.name?.trim() || `ZenTao Project ${row.id}`,
      code: row.code?.trim() || "",
      description: plainText(row.desc),
      status: isClosed(row) ? "closed" : row.status?.trim() || "wait",
      pm_account: row.PM?.trim() || null,
      members: [],
      metadata_json: JSON.stringify({ zentao: {
        code: row.code?.trim() || "",
        status: isClosed(row) ? "closed" : row.status?.trim() || "wait",
        model: row.model ?? null,
        deleted: row.deleted ?? false,
      } }),
    }));

    const active = projects.filter((project) => project.status !== "closed");
    await this.mapConcurrent(active, async (project) => {
      const data = await this.requestJson<{ members?: MemberRow[] }>(`/api.php/v2/projects/${encodeURIComponent(project.external_id)}/members`);
      if (!Array.isArray(data.members)) throw new Error(`invalid ZenTao response: projects/${project.external_id}/members`);
      project.members = data.members.flatMap((member) => {
        const account = member.account?.trim();
        return account ? [{ external_id: `${project.external_id}:${account}`, account, role: "member" as const }] : [];
      });
    });

    return {
      provider_id: this.options.providerId ?? "zentao:main",
      identity_provider_id: this.options.identityProviderId,
      source_url: this.baseUrl,
      captured_at: new Date().toISOString(),
      complete: true,
      projects,
    };
  }

  private async fetchAllProjects(): Promise<ProjectRow[]> {
    const projects: ProjectRow[] = [];
    for (let page = 1; ; page += 1) {
      const data = await this.requestJson<{ projects?: ProjectRow[]; pager?: { page?: number; pageTotal?: number } }>(
        `/api.php/v2/projects?browseType=all&recPerPage=1000&pageID=${page}`,
      );
      if (!Array.isArray(data.projects)) throw new Error("invalid ZenTao response: projects");
      projects.push(...data.projects);
      const pageTotal = Number(data.pager?.pageTotal);
      if ((Number.isFinite(pageTotal) && page >= pageTotal) || data.projects.length < 1000) break;
    }
    return projects;
  }

  private async login(): Promise<string> {
    const password = await this.options.passwordProvider();
    if (!password) throw new Error("ZenTao password is empty");
    const response = await this.fetchWithTimeout(`${this.baseUrl}/api.php/v2/users/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: this.options.account, password }),
    });
    if (!response.ok) throw new Error(`ZenTao login failed: HTTP ${response.status}`);
    const body = await response.json() as { token?: string };
    if (!body.token) throw new Error("ZenTao login response has no token");
    this.token = body.token;
    return body.token;
  }

  private async requestJson<T>(path: string, retried = false): Promise<T> {
    const token = this.token ?? await this.login();
    const response = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
      headers: { Token: token },
    });
    if (response.status === 401 && !retried) {
      this.token = null;
      await this.login();
      return this.requestJson<T>(path, true);
    }
    if (!response.ok) throw new Error(`ZenTao request failed: ${path} HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async mapConcurrent<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(this.memberConcurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        await fn(items[index]!);
      }
    });
    await Promise.all(workers);
  }
}
