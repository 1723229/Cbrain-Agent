import { beforeEach, describe, expect, it, vi } from "vitest";

describe("team delete contract", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
  });

  it("sends the array-shaped team_ids payload required by the Core schema", async () => {
    const { setPanelSession } = await import("../web/src/lib/panelSession.js");
    const { teamsApi } = await import("../web/src/lib/api/teams.js");
    setPanelSession({ instanceId: "default" });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 0,
            message: "ok",
            request_id: "request-1",
            data: { ok: true },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await teamsApi.delete("team-one");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ team_ids: ["team-one"] });
  });

  it("advances filtered list pages by limit instead of returned item count", async () => {
    const { setPanelSession } = await import("../web/src/lib/panelSession.js");
    const { metaListAll } = await import("../web/src/lib/api/base.js");
    setPanelSession({ instanceId: "default" });
    const offsets: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { offset: number };
      offsets.push(body.offset);
      const items = body.offset === 100 ? [{ id: "late" }] : [];
      return new Response(JSON.stringify({
        code: 0,
        message: "ok",
        request_id: "request-list",
        data: { items, total: 201 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    await expect(metaListAll<{ id: string }>("asset/list", {})).resolves.toEqual([{ id: "late" }]);
    expect(offsets).toEqual([0, 100, 200]);
  });

  it("uses the explicit member role endpoint instead of re-adding the member", async () => {
    const { setPanelSession } = await import("../web/src/lib/panelSession.js");
    const { membersApi } = await import("../web/src/lib/api/teams.js");
    setPanelSession({ instanceId: "default" });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      message: "ok",
      request_id: "request-role",
      data: { team_id: "team-one", user_id: "usr-member", role: "admin" },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await membersApi.updateRole("team-one", "usr-member", "admin");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/meta/team-member/role/update");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      team_id: "team-one",
      user_id: "usr-member",
      role: "admin",
    });
  });

  it("prevents owner and self role changes while allowing peer administration", async () => {
    const { canChangeMemberRole } = await import("../web/src/components/team/types.js");
    const team = {
      team_id: "team-one",
      name: "Team One",
      description: "",
      owner_user_id: "usr-owner",
      created_at_ms: 0,
      members: [
        { user_id: "usr-owner", role: "admin" as const, joined_at_ms: 0 },
        { user_id: "usr-admin", role: "admin" as const, joined_at_ms: 0 },
        { user_id: "usr-member", role: "member" as const, joined_at_ms: 0 },
      ],
    };

    expect(canChangeMemberRole(team, "usr-owner", "usr-admin", false)).toBe(false);
    expect(canChangeMemberRole(team, "usr-admin", "usr-admin", false)).toBe(false);
    expect(canChangeMemberRole(team, "usr-member", "usr-admin", false)).toBe(true);
    expect(canChangeMemberRole(team, "usr-member", "usr-member", true)).toBe(false);
  });
});
