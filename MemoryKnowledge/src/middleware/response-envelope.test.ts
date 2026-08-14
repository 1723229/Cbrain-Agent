import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { accessLog } from "./response-envelope.js";

describe("knowledge access log middleware", () => {
  it("does not consume request or error response bodies", async () => {
    const app = new Hono();
    app.use("*", accessLog());
    app.post("/echo", async (c) => {
      const body = await c.req.json<{ team_id: string }>();
      return c.json({ received: body.team_id }, 400);
    });

    const response = await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ team_id: "team-test" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ received: "team-test" });
  });
});
