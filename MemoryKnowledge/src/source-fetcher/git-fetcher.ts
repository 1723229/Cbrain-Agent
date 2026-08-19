/**
 * GitSourceFetcher — 基于 simple-git 的源码拉取实现。
 *
 * simple-git 内部用 child_process.spawn + args 数组，不走 shell，从原理上消除 shell 注入。
 *
 * 安全防护（002 §4-5）：
 *   - R1 git hooks：clone/fetch 本就不拉取远端 .git/hooks（hooks 为本地态），故不额外
 *     配置 core.hooksPath（加固版 git 会拒绝该配置，需 allowUnsafeHooksPath）。
 *   - R2 SSRF：只允许 HTTP(S) + 内网/环回地址黑名单（对齐项目 security_rules）。
 *     内网 GitLab 可通过 KNOWLEDGE_GIT_ALLOWED_HOSTS 精确放行主机，不需要关闭全局校验。
 *   - Bug 修复（方案 A）：增量 sync 的 git clean 排除 .codegraph/，避免删掉 codegraph 索引库。
 */

import simpleGit, { CleanOptions, ResetMode } from "simple-git";
import type { ISourceFetcher, FetchResult, SourceType } from "./types.js";

/**
 * 内网 / 环回 / link-local 地址黑名单（标准网段）：
 *   - 10. / 172.16-31. / 192.168.  → RFC1918 私有网段
 *   - 169.254.                     → link-local（含云元数据 169.254.169.254）
 *   - 127. / 0. / localhost / ::1  → 环回
 *   - fe80:                        → IPv6 link-local
 *
 * 该黑名单可通过环境变量 KNOWLEDGE_SSRF_CHECK=off 关闭（见 GitSourceFetcher 构造）。
 */
const PRIVATE_ADDR_RE =
  /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|127\.|0\.|localhost$|::1$|fe80:)/i;

/**
 * 读取 SSRF 私网黑名单开关。默认开启；
 * 当 KNOWLEDGE_SSRF_CHECK 为 off/false/0/no（大小写不敏感）时关闭。
 */
function ssrfCheckEnabledFromEnv(): boolean {
  const raw = process.env.KNOWLEDGE_SSRF_CHECK;
  if (raw == null || raw.trim() === "") return true;
  const v = raw.trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0" || v === "no");
}

function allowedHostsFromEnv(): string[] {
  return (process.env.KNOWLEDGE_GIT_ALLOWED_HOSTS ?? "")
    .split(/[\s,]+/)
    .map((host) => normalizeHost(host))
    .filter(Boolean);
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

export interface GitSourceFetcherOptions {
  /**
   * 是否启用 SSRF 私网 / 环回地址黑名单校验。
   * 默认读环境变量 KNOWLEDGE_SSRF_CHECK（默认开启）；显式传入时优先于环境变量。
   */
  ssrfCheck?: boolean;
  /** 精确放行的 Git 主机名/IP；仅用于绕过私网地址拦截，不改变协议校验。 */
  allowedHosts?: string[];
}

export class GitSourceFetcher implements ISourceFetcher {
  readonly supportedType: SourceType = "git";

  /** SSRF 私网黑名单校验开关。HTTP/HTTPS 协议校验始终生效。 */
  private readonly ssrfCheck: boolean;
  /** 显式允许访问的 Git 主机，仅按 hostname 精确匹配。 */
  private readonly allowedHosts: ReadonlySet<string>;

  constructor(opts?: GitSourceFetcherOptions) {
    this.ssrfCheck = opts?.ssrfCheck ?? ssrfCheckEnabledFromEnv();
    this.allowedHosts = new Set((opts?.allowedHosts ?? allowedHostsFromEnv()).map(normalizeHost).filter(Boolean));
  }

  validate(sourceUrl: string): void {
    if (sourceUrl.startsWith("git@") || sourceUrl.startsWith("ssh://")) {
      throw new Error("repo_url must use HTTP or HTTPS; SSH repository URLs are not supported");
    }
    let parsed: URL;
    try {
      parsed = new URL(sourceUrl);
    } catch {
      throw new Error(`invalid repo_url: cannot parse URL from ${sourceUrl}`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(
        "repo_url must use HTTP or HTTPS; SSH repository URLs are not supported",
      );
    }
    const host = normalizeHost(parsed.hostname);
    if (!host) {
      throw new Error(`invalid repo_url: cannot parse host from ${sourceUrl}`);
    }
    // R2: SSRF 防护 —— 禁止指向内网 / 环回地址（可经 KNOWLEDGE_SSRF_CHECK=off 关闭）。
    if (this.ssrfCheck && this.isPrivateAddress(host) && !this.allowedHosts.has(host)) {
      throw new Error(
        `repo_url must not point to private/loopback address: ${host}; add it to KNOWLEDGE_GIT_ALLOWED_HOSTS or disable the SSRF check explicitly`,
      );
    }
  }

  async fetch(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
    this.validate(sourceUrl);
    // 浅克隆单分支。注：git clone/fetch 不会拉取远端的 .git/hooks（hooks 是本地态），
    // 所以正常仓库 clone 出来不带可执行钩子；此处不再配置 core.hooksPath
    // （加固版 git 会拒绝该配置：需 allowUnsafeHooksPath）。
    await simpleGit().clone(sourceUrl, localPath, {
      "--depth": 1,
      "--branch": branch,
    });
    const version = await this.headCommit(localPath);
    return { localPath, version, sourceType: "git" };
  }

  async sync(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
    this.validate(sourceUrl);
    const git = simpleGit(localPath);
    await git.fetch("origin", branch, { "--depth": 1 });
    await git.reset(ResetMode.HARD, [`origin/${branch}`]);
    // Bug 修复（方案 A）：clean 排除 .codegraph/，否则会删掉 codegraph 的索引库，
    // 导致增量 sync 永远失败、每次回退到全量 clone。
    await git.clean(CleanOptions.FORCE + CleanOptions.RECURSIVE, ["-e", ".codegraph"]);
    const version = await this.headCommit(localPath);
    return { localPath, version, sourceType: "git" };
  }

  // ── 内部 helper ──

  private async headCommit(localPath: string): Promise<string | null> {
    try {
      return (await simpleGit(localPath).revparse(["HEAD"])).trim().slice(0, 12);
    } catch {
      return null;
    }
  }

  private isPrivateAddress(host: string): boolean {
    return PRIVATE_ADDR_RE.test(host);
  }
}
