import { describe, expect, it, vi } from "vitest";
import { ZentaoClient } from "../src/panel/integrations/zentao/zentao-client.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("ZentaoClient", () => {
  it("登录后分页读取项目，并只为未关闭项目读取成员", async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/users/login")) return response({ token: "token-1" });
      if (url.includes("/projects?") && url.includes("pageID=1")) {
        return response({ projects: [
          { id: 1, name: "APS", code: "aps", status: "doing", PM: "pm", desc: "<p>desc</p>" },
          { id: 2, name: "Old", code: "old", status: "closed", PM: "oldpm", desc: "" },
        ], pager: { page: 1, pageTotal: 1 } });
      }
      if (url.endsWith("/projects/1/members")) {
        return response({ members: [
          { id: 9, account: "dev", realname: "Dev" },
          { id: 10, account: "pm", realname: "Project Manager" },
        ] });
      }
      if (url.endsWith("/projects/1")) {
        return response({ status: "success", project: { id: 1, PM: "pm" } });
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = new ZentaoClient({
      baseUrl: "https://zentao.example.test/",
      account: "admin",
      passwordProvider: () => "secret",
      identityProviderId: "ldap:zjyj",
      fetchFn,
    });
    const snapshot = await client.fetchSnapshot();
    expect(snapshot.complete).toBe(true);
    expect(snapshot.projects).toHaveLength(2);
    expect(snapshot.projects[0]).toMatchObject({ external_id: "1", description: "desc", pm_account: "pm" });
    expect(snapshot.projects[0]?.members).toEqual([
      { external_id: "1:dev", account: "dev", role: "member" },
      { external_id: "1:pm", account: "pm", role: "member" },
    ]);
    expect(snapshot.projects[1]?.members).toEqual([]);
    expect(fetchFn.mock.calls.some(([url]) => String(url).endsWith("/projects/2/members"))).toBe(false);
  });

  it("项目列表 PM 为姓名时，以项目详情返回的账号为准", async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/users/login")) return response({ token: "token" });
      if (url.includes("/projects?")) {
        return response({ projects: [{ id: 302, name: "亚通MES", code: "", status: "doing", PM: "魏晓龙" }], pager: { page: 1, pageTotal: 1 } });
      }
      if (url.endsWith("/projects/302/members")) {
        return response({ members: [{ id: 311, account: "weixl", realname: "魏晓龙", role: "项目经理" }] });
      }
      if (url.endsWith("/projects/302")) {
        return response({ status: "success", project: { id: 302, PM: "weixl" } });
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = new ZentaoClient({
      baseUrl: "https://zentao.example.test",
      account: "admin",
      passwordProvider: () => "secret",
      identityProviderId: "ldap:zjyj",
      fetchFn,
    });

    const result = await client.fetchSnapshot();
    expect(result.projects[0]).toMatchObject({ external_id: "302", pm_account: "weixl" });
  });

  it("业务请求 401 时刷新 token 并只重试一次", async () => {
    let loginCount = 0;
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/users/login")) return response({ token: `token-${++loginCount}` });
      if (url.includes("/projects?")) {
        const headers = new Headers(init?.headers);
        return headers.get("Token") === "token-1"
          ? response({ message: "expired" }, 401)
          : response({ projects: [], pager: { page: 1, pageTotal: 1 } });
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = new ZentaoClient({
      baseUrl: "https://zentao.example.test",
      account: "admin",
      passwordProvider: () => "secret",
      identityProviderId: "ldap:zjyj",
      fetchFn,
    });
    await expect(client.fetchSnapshot()).resolves.toMatchObject({ projects: [] });
    expect(loginCount).toBe(2);
  });

  it("任一成员接口失败时拒绝整个快照", async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/users/login")) return response({ token: "token" });
      if (url.includes("/projects?")) return response({ projects: [{ id: 1, name: "P", code: "p", status: "doing" }], pager: { page: 1, pageTotal: 1 } });
      return response({ message: "boom" }, 500);
    });
    const client = new ZentaoClient({
      baseUrl: "https://zentao.example.test",
      account: "admin",
      passwordProvider: () => "secret",
      identityProviderId: "ldap:zjyj",
      fetchFn,
    });
    await expect(client.fetchSnapshot()).rejects.toThrow(/projects\/1\/members/);
  });
});
