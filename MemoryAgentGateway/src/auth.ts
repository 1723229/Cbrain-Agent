import { createHash } from "node:crypto";
import type { CoreDirectoryClient } from "./core-client.js";
import type { GatewayPrincipal } from "./types.js";

interface CacheEntry { userId: string | null; expiresAt: number }

export interface GatewayAuthenticatorOptions {
  directory: Pick<CoreDirectoryClient, "verifyUserKey">;
  cacheTtlMs?: number;
  negativeCacheTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export class GatewayAuthenticationError extends Error {}

export class GatewayAuthenticator {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly now: () => number;

  constructor(private readonly options: GatewayAuthenticatorOptions) {
    this.now = options.now ?? Date.now;
  }

  async authenticate(authorization: string | undefined): Promise<GatewayPrincipal> {
    const credential = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!credential) throw new GatewayAuthenticationError("unauthorized");
    const cacheKey = createHash("sha256").update(credential).digest("hex");
    const cached = this.cache.get(cacheKey);
    const now = this.now();
    if (cached && cached.expiresAt > now) return this.principal(cached.userId, credential);
    if (cached) this.cache.delete(cacheKey);

    const userId = await this.options.directory.verifyUserKey(credential);
    this.remember(cacheKey, userId, now);
    return this.principal(userId, credential);
  }

  private principal(userId: string | null, userKey: string): GatewayPrincipal {
    if (!userId) throw new GatewayAuthenticationError("unauthorized");
    return { id: `user:${userId}`, userId, userKey };
  }

  private remember(key: string, userId: string | null, now: number): void {
    const maxEntries = this.options.maxEntries ?? 1_000;
    while (this.cache.size >= maxEntries) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, { userId, expiresAt: now + (userId ? this.options.cacheTtlMs ?? 30_000 : this.options.negativeCacheTtlMs ?? 3_000) });
  }
}
