/**
 * Knowledge 抽取任务内存态（本期临时方案，下期持久化）。
 *
 * KS → Panel 的 status-callback 是 S2S。任务只保存 owner_user_id，不保存
 * Web Session 或 Agent API Key；回调通过受保护的 Core internal 路由登记资产。
 *
 * 进程重启会丢任务——已知 corner，由前端 register-meta 兜底补建，
 * 下期持久化后根治。
 */

export interface KnowledgeTask {
  knowledge_id: string;
  type: 'wiki' | 'code-graph';
  team_id: string;
  owner_user_id: string;
  service_id: string;
  created_at: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h：codegraph 构建通常数分钟，留足余量

export class KnowledgeTaskRegistry {
  private readonly tasks = new Map<string, KnowledgeTask>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  record(task: KnowledgeTask): void {
    this.sweep();
    this.tasks.set(task.knowledge_id, task);
  }

  peek(knowledgeId: string): KnowledgeTask | undefined {
    this.sweep();
    return this.tasks.get(knowledgeId);
  }

  /** 取出并删除——callback 注册成功后调用，清掉已完结任务。 */
  take(knowledgeId: string): KnowledgeTask | undefined {
    const t = this.tasks.get(knowledgeId);
    this.tasks.delete(knowledgeId);
    return t;
  }

  size(): number {
    return this.tasks.size;
  }

  /** 删掉过期任务，防泄漏。record/peek 时顺手调。 */
  sweep(now: number = Date.now()): void {
    for (const [id, t] of this.tasks) {
      if (now - t.created_at > this.ttlMs) this.tasks.delete(id);
    }
  }
}
