import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyGitAuth,
  createGitAuth,
  loadGitAuthFromEnv,
  type GitAuthConfig,
} from "./git-auth.js";

function fakeGit() {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    env(name: string, value: string) {
      calls.push([name, value]);
      return this;
    },
  };
}

describe("Git HTTP authentication", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("loads a token from the direct development environment and requires host scoping", () => {
    vi.stubEnv("KNOWLEDGE_GIT_TOKEN", "fake-token");
    vi.stubEnv("KNOWLEDGE_GIT_AUTH_HOSTS", "10.0.0.5, gitlab.example.internal");

    const auth = loadGitAuthFromEnv();

    expect(auth?.username).toBe("oauth2");
    expect(auth?.authHosts).toEqual(new Set(["10.0.0.5", "gitlab.example.internal"]));
  });

  it("fails closed when a token is configured without an auth host", () => {
    vi.stubEnv("KNOWLEDGE_GIT_TOKEN", "fake-token");

    expect(() => loadGitAuthFromEnv()).toThrow(/KNOWLEDGE_GIT_AUTH_HOSTS/);
  });

  it("loads the preferred token file", () => {
    const dir = mkdtempSync(join(process.env.TEMP ?? process.cwd(), "cbrain-git-auth-"));
    const tokenFile = join(dir, "read-token");
    writeFileSync(tokenFile, "fake-file-token\n", { encoding: "utf8", mode: 0o600 });
    try {
      const auth = loadGitAuthFromEnv({
        KNOWLEDGE_GIT_TOKEN_FILE: tokenFile,
        KNOWLEDGE_GIT_AUTH_HOSTS: "10.0.0.5",
      });

      expect(auth?.username).toBe("oauth2");
      expect(auth?.authHosts).toEqual(new Set(["10.0.0.5"]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("injects URL-scoped basic auth without changing the repository URL", () => {
    const auth = createGitAuth({ token: "fake-token", authHosts: ["10.0.0.5"] });
    const git = fakeGit();

    applyGitAuth(git as never, "http://10.0.0.5/yt-mes/yatong-mes.git", auth);

    expect(git.calls).toContainEqual(["GIT_TERMINAL_PROMPT", "0"]);
    const parameters = git.calls.find(([name]) => name === "GIT_CONFIG_PARAMETERS")?.[1] ?? "";
    expect(parameters).toContain("'http.http://10.0.0.5/.extraHeader=Authorization: Basic");
    expect(parameters).toContain(
      Buffer.from("oauth2:fake-token", "utf8").toString("base64"),
    );
    expect(parameters).toContain("'http.http://10.0.0.5/.followRedirects=false'");
    expect(git.calls.some(([name]) => name === "GIT_CONFIG_COUNT")).toBe(false);
  });

  it("does not send the configured credential outside the auth host boundary", () => {
    const auth: GitAuthConfig = createGitAuth({ token: "fake-token", authHosts: ["10.0.0.5"] });
    const git = fakeGit();

    expect(() => applyGitAuth(git as never, "https://gitlab.com/team/repository.git", auth)).not.toThrow();
    expect(git.calls.some(([name]) => name === "GIT_CONFIG_PARAMETERS")).toBe(false);
  });
});
