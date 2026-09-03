import type { Logger } from "../types.js";
import type { EmbeddingService } from "./embedding.js";
import type { DeferredL0EmbeddingJob, IMemoryStore } from "./types.js";

const TAG = "[deferred-l0-embedding]";
const inFlight = new WeakMap<IMemoryStore, Promise<void>>();

export function drainDeferredL0Embeddings(
  store: IMemoryStore,
  embedding: EmbeddingService,
  logger?: Logger,
  batchSize = 32,
): Promise<void> {
  const running = inFlight.get(store);
  if (running) return running;
  if (!supportsPersistentQueue(store)) return Promise.resolve();

  const task = drain(store, embedding, logger, batchSize)
    .catch((error) => {
      logger?.warn(`${TAG} worker failed; durable jobs remain queued: ${message(error)}`);
    })
    .finally(() => {
      if (inFlight.get(store) === task) inFlight.delete(store);
    });
  inFlight.set(store, task);
  return task;
}

async function drain(
  store: Required<Pick<IMemoryStore, "dueL0Embeddings" | "completeL0Embedding" | "retryL0Embedding" | "updateL0Embedding">>,
  embedding: EmbeddingService,
  logger: Logger | undefined,
  batchSize: number,
): Promise<void> {
  const limit = Math.max(1, Math.min(100, Math.floor(batchSize)));
  for (;;) {
    const jobs = await store.dueL0Embeddings(limit);
    if (jobs.length === 0) return;

    let vectors: Float32Array[];
    try {
      vectors = await embedding.embedBatch(jobs.map((job) => job.messageText));
    } catch (error) {
      const detail = message(error);
      await Promise.all(jobs.map((job) => fail(store, job, detail)));
      logger?.warn(`${TAG} batch failed; ${jobs.length} job(s) scheduled for retry: ${detail}`);
      return;
    }

    for (const [index, job] of jobs.entries()) {
      const vector = vectors[index];
      if (!vector) {
        await fail(store, job, "embedding response omitted a vector");
        continue;
      }
      const updated = await store.updateL0Embedding(job.recordId, vector);
      if (updated) await store.completeL0Embedding(job.recordId);
      else await fail(store, job, "vector update returned false");
    }
    if (jobs.length < limit) return;
  }
}

function supportsPersistentQueue(
  store: IMemoryStore,
): store is IMemoryStore & Required<Pick<IMemoryStore, "dueL0Embeddings" | "completeL0Embedding" | "retryL0Embedding" | "updateL0Embedding">> {
  return typeof store.dueL0Embeddings === "function" &&
    typeof store.completeL0Embedding === "function" &&
    typeof store.retryL0Embedding === "function" &&
    typeof store.updateL0Embedding === "function";
}

function fail(
  store: Required<Pick<IMemoryStore, "retryL0Embedding">>,
  job: DeferredL0EmbeddingJob,
  error: string,
): Promise<void> {
  return Promise.resolve(store.retryL0Embedding(job.recordId, job.attempts + 1, error));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
