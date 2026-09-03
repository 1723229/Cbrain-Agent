import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { IMemoryStore, L0Record } from "../core/store/types.js";
import type { EmbeddingService } from "../core/store/embedding.js";
import { VectorStore } from "../core/store/sqlite.js";
import { handleConversationAdd, type V2RouterDeps } from "./v2-router.js";

const auth = { apiKey: "service-key", serviceId: "default" };
const body = {
  session_id: "session-1",
  idempotency_key: "event-1234567890abcdef",
  messages: [
    { role: "user", content: "hello", recorded_at: "2026-09-03T10:00:00.000Z" },
    { role: "assistant", content: "world", recorded_at: "2026-09-03T10:00:00.001Z" },
  ],
};

describe("conversation/add idempotency", () => {
  it("returns before a deferred embedding request completes", async () => {
    const writes: L0Record[] = [];
    const store = deferredStore(writes);
    const never = new Promise<Float32Array[]>(() => undefined);
    const embedding = embeddingService({ embedBatch: vi.fn(() => never) });

    const result = await Promise.race([
      handleConversationAdd(body, auth, "req-1", deps(store, embedding)),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("handler blocked on embedding")), 100)),
    ]);

    expect(result.code).toBe(0);
    expect(writes).toHaveLength(2);
    expect(embedding.embedBatch).toHaveBeenCalledWith(["hello", "world"]);
  });

  it("generates the same message ids for retries of one event", async () => {
    const writes: L0Record[] = [];
    const store = deferredStore(writes);
    const embedding = embeddingService({ embedBatch: vi.fn(async () => []) });
    const testDeps = deps(store, embedding);

    const first = await handleConversationAdd(body, auth, "req-1", testDeps);
    const second = await handleConversationAdd(body, auth, "req-2", testDeps);

    expect(first.data).toEqual(second.data);
    expect(writes.slice(0, 2).map((record) => record.id)).toEqual(writes.slice(2, 4).map((record) => record.id));
    expect(writes.slice(0, 2).map((record) => record.recordedAt)).toEqual([
      "2026-09-03T10:00:00.000Z",
      "2026-09-03T10:00:00.001Z",
    ]);
  });

  it("batches deferred embeddings and updates the persisted records", async () => {
    const writes: L0Record[] = [];
    const updates: Array<{ recordId: string; embedding: Float32Array }> = [];
    const tracked: Promise<void>[] = [];
    const store = deferredStore(writes, updates);
    const vectors = [new Float32Array([1, 0]), new Float32Array([0, 1])];
    const embedding = embeddingService({ embedBatch: vi.fn(async () => vectors) });

    const result = await handleConversationAdd(body, auth, "req-1", {
      ...deps(store, embedding),
      trackBackgroundTask: (task) => tracked.push(task),
    });
    await Promise.all(tracked);

    expect(result.code).toBe(0);
    expect(embedding.embedBatch).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([
      { recordId: writes[0]!.id, embedding: vectors[0] },
      { recordId: writes[1]!.id, embedding: vectors[1] },
    ]);
  });

  it("uses one embedding batch for stores that require inline vectors", async () => {
    const writes: Array<{ record: L0Record; vector?: Float32Array }> = [];
    const vectors = [new Float32Array([1, 0]), new Float32Array([0, 1])];
    const store = {
      upsertL0: (record: L0Record, vector?: Float32Array) => {
        writes.push({ record, vector });
        return true;
      },
    } as unknown as IMemoryStore;
    const embedding = embeddingService({ embedBatch: vi.fn(async () => vectors) });

    const result = await handleConversationAdd(body, auth, "req-1", deps(store, embedding));

    expect(result.code).toBe(0);
    expect(embedding.embedBatch).toHaveBeenCalledTimes(1);
    expect(writes.map((write) => write.vector)).toEqual(vectors);
  });

  it("short-circuits a completed idempotent retry before embedding and pipeline notification", async () => {
    const stored = new Set<string>();
    const writes: L0Record[] = [];
    const embedding = embeddingService({ embedBatch: vi.fn(async () => []) });
    const notifyPipeline = vi.fn(async () => undefined);
    const store = {
      supportsDeferredEmbedding: true,
      hasL0: (recordId: string) => stored.has(recordId),
      upsertL0: (record: L0Record) => {
        stored.add(record.id);
        writes.push(record);
        return true;
      },
      updateL0Embedding: () => true,
    } as unknown as IMemoryStore;
    const testDeps = { ...deps(store, embedding), notifyPipeline };

    await handleConversationAdd(body, auth, "req-1", testDeps);
    await handleConversationAdd(body, auth, "req-2", testDeps);

    expect(writes).toHaveLength(2);
    expect(embedding.embedBatch).toHaveBeenCalledTimes(1);
    expect(notifyPipeline).toHaveBeenCalledTimes(1);
  });

  it("recreates missing durable vector jobs during an idempotent retry", async () => {
    const queued: string[] = [];
    const tracked: Promise<void>[] = [];
    const store = {
      supportsDeferredEmbedding: true,
      hasL0: () => true,
      upsertL0: vi.fn(() => true),
      enqueueL0Embedding: (recordId: string) => queued.push(recordId),
      dueL0Embeddings: () => [],
      completeL0Embedding: () => undefined,
      retryL0Embedding: () => undefined,
      updateL0Embedding: () => true,
    } as unknown as IMemoryStore;
    const embedding = embeddingService({ embedBatch: vi.fn(async () => []) });

    await handleConversationAdd(body, auth, "req-2", {
      ...deps(store, embedding),
      trackBackgroundTask: (task) => tracked.push(task),
    });
    await Promise.all(tracked);

    expect(store.upsertL0).not.toHaveBeenCalled();
    expect(queued).toHaveLength(2);
  });

  it("keeps only two rows in the real SQLite store after a repeated event", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cbrain-l0-idempotency-"));
    const store = new VectorStore(join(directory, "vectors.db"), 0);
    try {
      await store.init();
      const testDeps = deps(store, undefined);
      await handleConversationAdd(body, auth, "req-1", testDeps);
      await handleConversationAdd(body, auth, "req-2", testDeps);

      expect(await store.getAllL0Texts()).toHaveLength(2);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function deferredStore(
  writes: L0Record[],
  updates: Array<{ recordId: string; embedding: Float32Array }> = [],
): IMemoryStore {
  return {
    supportsDeferredEmbedding: true,
    upsertL0: (record: L0Record) => {
      writes.push(record);
      return true;
    },
    updateL0Embedding: (recordId: string, embedding: Float32Array) => {
      updates.push({ recordId, embedding });
      return true;
    },
  } as unknown as IMemoryStore;
}

function embeddingService(overrides: Partial<EmbeddingService>): EmbeddingService {
  return {
    getDimensions: () => 2,
    getProviderInfo: () => ({ provider: "test", model: "test" }),
    isReady: () => true,
    startWarmup: () => undefined,
    embed: vi.fn(async () => new Float32Array([1, 0])),
    embedBatch: vi.fn(async () => []),
    ...overrides,
  } as EmbeddingService;
}

function deps(store: IMemoryStore, embedding: EmbeddingService | undefined): V2RouterDeps {
  return {
    getStore: () => store,
    getEmbedding: () => embedding,
    getStorage: () => undefined,
    deployMode: "service",
    logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
    requestIsolation: {
      teamId: "team-1",
      userId: "user-1",
      agentId: "agent-1",
      sessionId: "session-1",
    },
  };
}
