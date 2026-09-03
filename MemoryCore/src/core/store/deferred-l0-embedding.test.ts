import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { EmbeddingService } from "./embedding.js";
import { drainDeferredL0Embeddings } from "./deferred-l0-embedding.js";
import { VectorStore } from "./sqlite.js";
import type { IMemoryStore } from "./types.js";

describe("deferred L0 embedding queue", () => {
  it("survives a store restart and removes a completed vector job", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cbrain-l0-embedding-"));
    const databasePath = join(directory, "vectors.db");
    const record = {
      id: "msg-persisted",
      sessionKey: "session-1",
      sessionId: "session-1",
      teamId: "team-1",
      userId: "user-1",
      agentId: "agent-1",
      role: "user",
      messageText: "persist this vector job",
      recordedAt: "2026-09-03T10:00:00.000Z",
      timestamp: Date.parse("2026-09-03T10:00:00.000Z"),
    };
    let first: VectorStore | undefined;
    let second: VectorStore | undefined;
    try {
      first = new VectorStore(databasePath, 2);
      await first.init({ provider: "test", model: "test" });
      expect(first.upsertL0(record, undefined)).toBe(true);
      first.enqueueL0Embedding(record.id, record.messageText);
      expect(first.dueL0Embeddings()).toHaveLength(1);
      first.close();
      first = undefined;

      second = new VectorStore(databasePath, 2);
      await second.init({ provider: "test", model: "test" });
      const embedding = {
        embedBatch: vi.fn(async () => [new Float32Array([1, 0])]),
      } as unknown as EmbeddingService;
      await drainDeferredL0Embeddings(second, embedding);

      expect(embedding.embedBatch).toHaveBeenCalledWith([record.messageText]);
      expect(second.dueL0Embeddings()).toHaveLength(0);
      second.enqueueL0Embedding(record.id, record.messageText);
      expect(second.dueL0Embeddings()).toHaveLength(0);
    } finally {
      first?.close();
      second?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists a bounded retry when the embedding dependency fails", async () => {
    const retry = vi.fn(() => undefined);
    const store = {
      dueL0Embeddings: () => [{ recordId: "msg-1", messageText: "hello", attempts: 2 }],
      completeL0Embedding: () => undefined,
      retryL0Embedding: retry,
      updateL0Embedding: () => true,
    } as unknown as IMemoryStore;
    const embedding = {
      embedBatch: vi.fn(async () => { throw new Error("embedding unavailable"); }),
    } as unknown as EmbeddingService;

    await expect(drainDeferredL0Embeddings(store, embedding)).resolves.toBeUndefined();

    expect(retry).toHaveBeenCalledWith("msg-1", 3, "embedding unavailable");
  });

  it("removes queued jobs when an L0 session is deleted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cbrain-l0-session-delete-"));
    const store = new VectorStore(join(directory, "vectors.db"), 2);
    try {
      await store.init({ provider: "test", model: "test" });
      const record = l0Record("msg-session-delete", "session-delete");
      store.upsertL0(record, undefined);
      store.enqueueL0Embedding(record.id, record.messageText);
      expect(store.dueL0Embeddings()).toHaveLength(1);

      expect(store.deleteL0BySession(record.sessionId)).toBe(1);
      expect(store.dueL0Embeddings()).toHaveLength(0);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes queued jobs when an Agent's memory content is cleared", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cbrain-l0-content-clear-"));
    const store = new VectorStore(join(directory, "vectors.db"), 2);
    try {
      await store.init({ provider: "test", model: "test" });
      const record = l0Record("msg-content-clear", "session-clear");
      store.upsertL0(record, undefined);
      store.enqueueL0Embedding(record.id, record.messageText);
      expect(store.dueL0Embeddings()).toHaveLength(1);

      expect(store.clearMemoryContent({ teamId: record.teamId, agentId: record.agentId })).toMatchObject({ l0Deleted: 1 });
      expect(store.dueL0Embeddings()).toHaveLength(0);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function l0Record(id: string, sessionId: string) {
  return {
    id,
    sessionKey: sessionId,
    sessionId,
    teamId: "team-1",
    userId: "user-1",
    agentId: "agent-1",
    role: "user" as const,
    messageText: `queued message ${id}`,
    recordedAt: "2026-09-03T10:00:00.000Z",
    timestamp: Date.parse("2026-09-03T10:00:00.000Z"),
  };
}
