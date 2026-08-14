import { createHash, randomBytes } from "node:crypto";

export const DEFAULT_WEB_SESSION_TTL_SECONDS = 12 * 60 * 60;

export function generateWebSessionToken(): string {
  return `cs-${randomBytes(32).toString("base64url")}`;
}

export function hashWebSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function webSessionExpiresAt(ttlSeconds = DEFAULT_WEB_SESSION_TTL_SECONDS): string {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}
