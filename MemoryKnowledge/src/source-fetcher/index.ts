/**
 * source-fetcher barrel — 源码拉取接口层对外出口。
 */

export type { ISourceFetcher, FetchResult, SourceType } from "./types.js";
export { GitSourceFetcher, type GitSourceFetcherOptions } from "./git-fetcher.js";
export {
  applyGitAuth,
  createGitAuth,
  loadGitAuthFromEnv,
  type GitAuthConfig,
  type GitAuthInput,
} from "./git-auth.js";
export { SourceFetcherRegistry } from "./registry.js";
