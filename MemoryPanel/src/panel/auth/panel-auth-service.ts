import type { PanelConfig } from '../config/panel-config.js';
import type { InstanceRegistry } from '../config/instance-registry.js';
import type { KernelHttpPort } from '../kernel/ports/kernel-http-port.js';
import type { PublicUser } from '../../web-shared/public-user.js';
import { LdapAuthenticationError, LdapAuthenticator } from './ldap-authenticator.js';
import { LoginRateLimiter } from './login-rate-limiter.js';

export class PanelAuthenticationError extends Error {
  constructor(readonly status: 401 | 429 | 503, readonly code: string) {
    super(code);
    this.name = 'PanelAuthenticationError';
  }
}

interface SessionResult {
  user: PublicUser;
  sessionToken: string;
  expiresAt: string;
}

export class PanelAuthService {
  private readonly ldap: LdapAuthenticator;
  private readonly limiter = new LoginRateLimiter();

  constructor(
    private readonly config: PanelConfig,
    private readonly registry: InstanceRegistry,
    private readonly kernelHttp: KernelHttpPort,
  ) {
    this.ldap = new LdapAuthenticator(config.ldap);
  }

  get ldapEnabled(): boolean {
    return this.config.ldap.enabled;
  }

  private credentials(instanceId: string) {
    const entry = this.registry.resolve(instanceId);
    return {
      endpoint: entry.gateway_endpoint,
      apiKey: entry.api_key,
      instanceId: entry.instance_id,
      timeoutMs: this.config.metadataRemoteTimeoutMs,
    };
  }

  async loginLdap(instanceId: string, username: string, password: string): Promise<SessionResult> {
    // 不信任客户端可伪造的 X-Forwarded-For。按账号限流才能真正阻断单账号爆破。
    const rateKey = `ldap:${username.trim().toLocaleLowerCase()}`;
    try {
      this.limiter.assertAllowed(rateKey);
    } catch {
      throw new PanelAuthenticationError(429, 'TOO_MANY_LOGIN_ATTEMPTS');
    }

    try {
      const profile = await this.ldap.authenticate(username, password);
      const env = await this.kernelHttp.postEnvelope<{
        user: PublicUser;
        session_token: string;
        expires_at: string;
      }>('/v3/internal/meta/federated/login', {
        provider_id: this.config.ldap.providerId,
        subject_id: profile.subjectId,
        username: profile.username,
        display_name: profile.displayName,
        email: profile.email,
        raw_profile_json: profile.rawProfileJson,
        ttl_seconds: this.config.session.ttlSeconds,
      }, this.credentials(instanceId));
      if (env.code !== 0 || !env.data) throw new PanelAuthenticationError(503, 'AUTH_BACKEND_UNAVAILABLE');
      this.limiter.clear(rateKey);
      return { user: env.data.user, sessionToken: env.data.session_token, expiresAt: env.data.expires_at };
    } catch (err) {
      if (err instanceof PanelAuthenticationError) throw err;
      this.limiter.recordFailure(rateKey);
      if (err instanceof LdapAuthenticationError && err.code === 'invalid_credentials') {
        throw new PanelAuthenticationError(401, 'INVALID_CREDENTIALS');
      }
      throw new PanelAuthenticationError(503, 'LDAP_UNAVAILABLE');
    }
  }

  async loginAdminApiKey(instanceId: string, apiKey: string): Promise<SessionResult> {
    // 应急入口使用全局桶，避免通过伪造代理头绕过限流。
    const rateKey = 'admin-api-key';
    try {
      this.limiter.assertAllowed(rateKey);
    } catch {
      throw new PanelAuthenticationError(429, 'TOO_MANY_LOGIN_ATTEMPTS');
    }
    if (!apiKey.trim()) {
      this.limiter.recordFailure(rateKey);
      throw new PanelAuthenticationError(401, 'INVALID_CREDENTIALS');
    }
    const env = await this.kernelHttp.postEnvelope<{
      user: PublicUser;
      session_token: string;
      expires_at: string;
    }>('/v3/internal/meta/session/login-admin-api-key', {
      api_key: apiKey,
      ttl_seconds: this.config.session.ttlSeconds,
    }, this.credentials(instanceId));
    if (env.code === 401 || env.code === 403) {
      this.limiter.recordFailure(rateKey);
      throw new PanelAuthenticationError(401, 'INVALID_CREDENTIALS');
    }
    if (env.code !== 0 || !env.data) throw new PanelAuthenticationError(503, 'AUTH_BACKEND_UNAVAILABLE');
    this.limiter.clear(rateKey);
    return { user: env.data.user, sessionToken: env.data.session_token, expiresAt: env.data.expires_at };
  }

  async resolveSession(instanceId: string, sessionToken: string): Promise<PublicUser | null> {
    if (!sessionToken.startsWith('cs-')) return null;
    const env = await this.kernelHttp.postEnvelope<{ user: PublicUser }>(
      '/v3/internal/meta/session/resolve',
      { session_token: sessionToken },
      this.credentials(instanceId),
    );
    return env.code === 0 && env.data?.user ? env.data.user : null;
  }

  async revokeSession(instanceId: string, sessionToken: string): Promise<void> {
    await this.kernelHttp.postEnvelope(
      '/v3/internal/meta/session/revoke',
      { session_token: sessionToken },
      this.credentials(instanceId),
    );
  }

  async syncLdapUsers(): Promise<{
    directoryUsers: number;
    instances: Array<{ instanceId: string; created: number; updated: number; deactivated: number }>;
  }> {
    const users = await this.ldap.listUsers();
    const instances: Array<{ instanceId: string; created: number; updated: number; deactivated: number }> = [];
    for (const entry of this.registry.listAll()) {
      const env = await this.kernelHttp.postEnvelope<{
        created: number;
        updated: number;
        deactivated: number;
      }>('/v3/internal/meta/federated/sync', {
        provider_id: this.config.ldap.providerId,
        complete: true,
        users: users.map((user) => ({
          subject_id: user.subjectId,
          username: user.username,
          display_name: user.displayName,
          email: user.email,
          raw_profile_json: user.rawProfileJson,
        })),
      }, this.credentials(entry.instance_id));
      if (env.code !== 0 || !env.data) throw new Error(`federated sync rejected for ${entry.instance_id}: ${env.code}`);
      instances.push({ instanceId: entry.instance_id, ...env.data });
    }
    return { directoryUsers: users.length, instances };
  }
}
