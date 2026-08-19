/**
 * Git HTTP(S) authentication for server-side repository fetches.
 *
 * Credentials are injected into the spawned git process through Git's
 * environment-backed config. They never become part of repo_url, the git
 * remote URL, or an application log message.
 */

import { readFileSync } from "node:fs";
import type { SimpleGit } from "simple-git";

export interface GitAuthInput {
  /** GitLab PATs should use `oauth2`; deploy tokens use their own username. */
  username?: string;
  token: string;
  /** Exact hostnames/IPs allowed to receive this credential. */
  authHosts: string[];
}

export interface GitAuthConfig {
  readonly username: string;
  readonly token: string;
  readonly authHosts: ReadonlySet<string>;
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

export function parseHostList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map(normalizeHost)
    .filter(Boolean);
}

/**
 * Load optional Git credentials from environment variables.
 *
 * `KNOWLEDGE_GIT_TOKEN_FILE` is the preferred deployment mechanism. The
 * direct `KNOWLEDGE_GIT_TOKEN` fallback is retained for local/dev execution.
 * A configured token must always have an exact host allowlist.
 */
export function loadGitAuthFromEnv(source: NodeJS.ProcessEnv = process.env): GitAuthConfig | undefined {
  const tokenFile = source.KNOWLEDGE_GIT_TOKEN_FILE?.trim() ?? "";
  const directToken = source.KNOWLEDGE_GIT_TOKEN?.trim() ?? "";
  if (tokenFile && directToken) {
    throw new Error("KNOWLEDGE_GIT_TOKEN_FILE and KNOWLEDGE_GIT_TOKEN are mutually exclusive");
  }
  if (!tokenFile && !directToken) return undefined;

  let token = directToken;
  if (tokenFile) {
    try {
      token = readFileSync(tokenFile, "utf8").trim();
    } catch {
      throw new Error("KNOWLEDGE_GIT_TOKEN_FILE could not be read");
    }
  }
  if (!token) {
    throw new Error("KNOWLEDGE_GIT_TOKEN_FILE must contain a non-empty token");
  }

  const authHosts = parseHostList(source.KNOWLEDGE_GIT_AUTH_HOSTS);
  if (authHosts.length === 0) {
    throw new Error("KNOWLEDGE_GIT_AUTH_HOSTS is required when Git credentials are configured");
  }

  return createGitAuth({
    username: source.KNOWLEDGE_GIT_USERNAME?.trim() || "oauth2",
    token,
    authHosts,
  });
}

export function createGitAuth(input: GitAuthInput): GitAuthConfig {
  const token = input.token.trim();
  if (!token) throw new Error("Git credential token must be non-empty");
  const authHosts = [...new Set(input.authHosts.map(normalizeHost).filter(Boolean))];
  if (authHosts.length === 0) throw new Error("Git credential authHosts must be non-empty");
  return {
    username: input.username?.trim() || "oauth2",
    token,
    authHosts: new Set(authHosts),
  };
}

/**
 * Configure one simple-git instance for one repository URL.
 *
 * The URL-scoped `http.<url>.extraHeader` key prevents the Authorization
 * header from being sent to a different host. `GIT_TERMINAL_PROMPT=0` also
 * makes a missing/invalid credential fail fast instead of hanging a worker.
 */
export function applyGitAuth(git: SimpleGit, sourceUrl: string, auth?: GitAuthConfig): void {
  git.env("GIT_TERMINAL_PROMPT", "0");
  if (!auth) return;

  const parsed = new URL(sourceUrl);
  const host = normalizeHost(parsed.hostname);
  if (!auth.authHosts.has(host)) {
    // Public repositories on other hosts remain usable; the credential is
    // simply not sent outside the explicit auth host allowlist.
    return;
  }

  const scope = `${parsed.protocol}//${parsed.host}/`;
  const basic = Buffer.from(`${auth.username}:${auth.token}`, "utf8").toString("base64");
  const configEntries: Array<[string, string]> = [
    [`http.${scope}.extraHeader`, `Authorization: Basic ${basic}`],
    [`http.${scope}.followRedirects`, "false"],
  ];
  const parameters = configEntries
    .map(([key, value]) => `'${key}=${value.replace(/'/g, "'\\''")}'`)
    .join(" ");
  const inheritedParameters = process.env.GIT_CONFIG_PARAMETERS?.trim();
  git.env(
    "GIT_CONFIG_PARAMETERS",
    [inheritedParameters, parameters].filter(Boolean).join(" "),
  );
}
