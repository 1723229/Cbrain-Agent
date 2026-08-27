import { describe, expect, it, vi } from "vitest";

import { fetchAllMetaListItems } from "../src/panel/http/routes/knowledge/common.js";
import type { PanelDeps } from "../src/panel/panel-deps.js";

const ctx = {
  instanceId: "default",
  gatewayEndpoint: "http://core",
  gatewayApiKey: "service",
};

describe("Panel meta pagination safety", () => {
  it("continues after an empty filtered page while total indicates later rows", async () => {
    const invoke = vi.fn(
      async (_action: string, body: Record<string, unknown>) => {
        const offset = Number(body.offset);
        if (offset === 100)
          return {
            code: 0,
            message: "ok",
            data: { items: [{ id: "late" }], total: 201 },
          };
        return { code: 0, message: "ok", data: { items: [], total: 201 } };
      },
    );
    const deps = { metaKernel: { invoke } } as unknown as PanelDeps;

    await expect(
      fetchAllMetaListItems<{ id: string }>(
        deps,
        ctx,
        "agent-fixed-asset/list-with-detail",
        {},
      ),
    ).resolves.toEqual([{ id: "late" }]);
    expect(
      invoke.mock.calls.map(
        (call) => (call[1] as Record<string, unknown>).offset,
      ),
    ).toEqual([0, 100, 200]);
  });

  it("reports a list failure so callers can refuse destructive replacement writes", async () => {
    const onError = vi.fn();
    const deps = {
      metaKernel: {
        invoke: async () => ({
          code: 503,
          message: "core unavailable",
          data: null,
        }),
      },
    } as unknown as PanelDeps;

    const items = await fetchAllMetaListItems(
      deps,
      ctx,
      "agent-fixed-asset/list",
      {},
      onError,
    );
    expect(items).toEqual([]);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 503 }),
    );
  });
});
