import { describe, expect, it } from "vitest";

import { createHealthRoutes } from "./health.js";

describe("knowledge health route", () => {
  it("reports a valid service health payload", async () => {
    const response = await createHealthRoutes().request("/health");
    const body = await response.json() as { status: string; timestamp: string };

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });
});
