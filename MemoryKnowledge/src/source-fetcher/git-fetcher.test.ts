import { afterEach, describe, expect, it, vi } from "vitest";
import { GitSourceFetcher } from "./git-fetcher.js";

describe("GitSourceFetcher URL policy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts GitLab/GitHub-style HTTP and HTTPS repository URLs", () => {
    const fetcher = new GitSourceFetcher();

    expect(() => fetcher.validate("https://gitlab.com/team/repository.git")).not.toThrow();
    expect(() => fetcher.validate("http://gitlab.example.internal/team/repository.git")).not.toThrow();
  });

  it("rejects SSH repository URLs with an actionable protocol error", () => {
    const fetcher = new GitSourceFetcher();

    expect(() => fetcher.validate("git@gitlab.com:team/repository.git")).toThrow(/HTTP or HTTPS/);
    expect(() => fetcher.validate("ssh://git@gitlab.com/team/repository.git")).toThrow(/HTTP or HTTPS/);
  });

  it("rejects credentials embedded in repository URLs", () => {
    const fetcher = new GitSourceFetcher();

    expect(() => fetcher.validate("https://user:password@gitlab.com/team/repository.git")).toThrow(
      /embedded credentials/,
    );
  });

  it("keeps private and loopback hosts blocked by default", () => {
    const fetcher = new GitSourceFetcher({ ssrfCheck: true });

    expect(() => fetcher.validate("http://10.0.0.5/team/repository.git")).toThrow(/KNOWLEDGE_GIT_ALLOWED_HOSTS/);
    expect(() => fetcher.validate("http://127.0.0.1/team/repository.git")).toThrow(/KNOWLEDGE_GIT_ALLOWED_HOSTS/);
  });

  it("allows an explicitly configured internal GitLab host without disabling SSRF checks", () => {
    const fetcher = new GitSourceFetcher({ ssrfCheck: true, allowedHosts: ["10.0.0.5"] });

    expect(() => fetcher.validate("http://10.0.0.5/team/repository.git")).not.toThrow();
    expect(() => fetcher.validate("http://10.0.0.6/team/repository.git")).toThrow(/private\/loopback/);
  });

  it("reads internal GitLab hosts from KNOWLEDGE_GIT_ALLOWED_HOSTS", () => {
    vi.stubEnv("KNOWLEDGE_GIT_ALLOWED_HOSTS", "10.0.0.5, gitlab.example.internal");
    const fetcher = new GitSourceFetcher({ ssrfCheck: true });

    expect(() => fetcher.validate("http://10.0.0.5/team/repository.git")).not.toThrow();
  });
});
