import { CoreClient } from "./core-client.js";
import { GatewayStore } from "./gateway-store.js";
import type { CoreClientConfig } from "./types.js";

export class CaptureWorker {
  private running = false;

  constructor(
    private readonly store: GatewayStore,
    private readonly coreConfig: CoreClientConfig,
    private readonly concurrency = 4,
    private readonly maxAttempts = 8,
  ) {}

  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await concurrent(this.store.dueCaptures(), this.concurrency, async (event) => {
        const context = this.store.getContextForWorker(event.contextId);
        if (!context) {
          if (event.coreStatus === "pending") this.store.markDeadSink(event.eventId, "core", "session context expired or missing");
          if (event.skillStatus === "pending") this.store.markDeadSink(event.eventId, "skill", "session context expired or missing");
          return;
        }
        const core = new CoreClient(this.coreConfig, context);
        const messages = [
          { role: "user" as const, content: event.user },
          { role: "assistant" as const, content: event.assistant },
        ];
        const jobs: Array<Promise<{ sink: "core" | "skill"; error?: string }>> = [];
        if (event.coreStatus === "pending") {
          jobs.push(core.addConversation(messages).then(
            () => ({ sink: "core" as const }),
            (error) => ({ sink: "core" as const, error: errorMessage(error) }),
          ));
        }
        if (event.skillStatus === "pending") {
          jobs.push(core.addSkillConversation(messages).then(
            () => ({ sink: "skill" as const }),
            (error) => ({ sink: "skill" as const, error: errorMessage(error) }),
          ));
        }
        const results = await Promise.all(jobs);
        const failed = results.filter((item) => item.error);
        for (const result of results) if (!result.error) this.store.markSink(event.eventId, result.sink);
        if (failed.length > 0) {
          const attempts = event.attempts + 1;
          const error = failed.map((item) => `${item.sink}: ${item.error}`).join("; ");
          if (attempts >= this.maxAttempts) {
            for (const item of failed) this.store.markDeadSink(event.eventId, item.sink, item.error!);
          } else {
            this.store.markRetry(event.eventId, attempts, error);
          }
        }
      });

      await concurrent(this.store.dueSkillExtractions(), this.concurrency, async (event) => {
        const context = this.store.getContextForWorker(event.contextId);
        if (!context) {
          this.store.markSkillExtractionDead(event.eventId, "session context expired or missing");
          return;
        }
        if (event.messages.length === 0) {
          this.store.markSkillExtractionSkipped(event.eventId, "no completed conversation was captured");
          return;
        }
        const toolCalls = event.messages.filter((message) => message.role === "tool_call").length;
        const workChars = event.messages
          .filter((message) => message.role === "user" || message.role === "assistant")
          .reduce((sum, message) => sum + message.content.length, 0);
        if (toolCalls < 1 || (toolCalls < 2 && workChars < 500)) {
          this.store.markSkillExtractionSkipped(
            event.eventId,
            `not enough reusable work evidence (tool_calls=${toolCalls}, work_chars=${workChars})`,
          );
          return;
        }
        try {
          const reason = "Codex session ended. Review the completed work trace for reusable procedures, including tool sequence, validation, failure recovery, and final outcome. Create or update a Skill only when the trace contains a repeatable workflow.";
          const result = await new CoreClient(this.coreConfig, context).extractSkill(event.messages, reason);
          this.store.markSkillExtractionSubmitted(event.eventId, result.task_id);
        } catch (error) {
          this.retryOrDeadSkill(event.eventId, event.attempts, errorMessage(error));
        }
      });
    } finally {
      this.running = false;
    }
  }

  private retryOrDeadSkill(eventId: string, previousAttempts: number, error: string): void {
    const attempts = previousAttempts + 1;
    if (attempts >= this.maxAttempts) this.store.markSkillExtractionDead(eventId, error);
    else this.store.markSkillExtractionRetry(eventId, attempts, error);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function concurrent<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index]!);
    }
  }));
}
