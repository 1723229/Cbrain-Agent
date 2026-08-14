import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { buildLdapUserFilter } from '../src/panel/auth/ldap-authenticator.js';
import { LoginRateLimiter } from '../src/panel/auth/login-rate-limiter.js';
import { PanelAuthService } from '../src/panel/auth/panel-auth-service.js';
import { InstanceRegistry } from '../src/panel/config/instance-registry.js';
import type { PanelConfig } from '../src/panel/config/panel-config.js';
import type { KernelHttpPort } from '../src/panel/kernel/ports/kernel-http-port.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { registerAuthRoutes } from '../src/panel/http/routes/auth.js';

function config(): PanelConfig {
  return {
    server: { host: '127.0.0.1', port: 8125 },
    metadataInstancesConfig: '',
    metadataRemoteTimeoutMs: 1000,
    ui: { distDir: '' },
    log: { level: 'error', format: 'json' },
    knowledge: { baseUrl: '', authToken: '', timeoutMs: 1000 },
    knowledgeLlmBinding: { sync: false, proxyBaseUrl: '' },
    ldap: {
      enabled: false,
      providerId: 'ldap:giga',
      url: 'ldap://127.0.0.1:389',
      userBaseDn: 'ou=people,dc=giga,dc=internal',
      bindDn: '',
      bindPasswordFile: '',
      startTls: false,
      caFile: '',
      allowInsecurePoc: false,
      connectTimeoutMs: 1000,
      operationTimeoutMs: 1000,
      syncIntervalMs: 300_000,
    },
    session: { cookieName: 'cbrain_session', secure: false, ttlSeconds: 43_200 },
  };
}

function registry(): InstanceRegistry {
  return new InstanceRegistry([{ instance_id: 'one', name: 'One', gateway_endpoint: 'http://core:8420', api_key: 'kernel' }]);
}

describe('Panel authentication', () => {
  it('escapes LDAP filter metacharacters', () => {
    const filter = buildLdapUserFilter('a*)(uid=*)');
    expect(filter).not.toContain('(uid=a*)(uid=*))');
    expect(filter).toContain('\\2a');
    expect(filter).toContain('\\29');
  });

  it('locks repeated login failures', () => {
    const limiter = new LoginRateLimiter(2, 1000, 5000);
    limiter.recordFailure('client', 100);
    limiter.recordFailure('client', 200);
    expect(() => limiter.assertAllowed('client', 300)).toThrow('rate_limited');
    expect(() => limiter.assertAllowed('client', 6000)).not.toThrow();
  });

  it('delegates administrator API key login to the trusted internal endpoint', async () => {
    const calls: string[] = [];
    const kernel: KernelHttpPort = {
      async postEnvelope(path, body) {
        calls.push(path);
        expect(body).toMatchObject({ api_key: 'sk-mem-admin', ttl_seconds: 43_200 });
        return {
          code: 0,
          message: 'ok',
          request_id: 'r1',
          data: {
            user: { user_id: 'usr-admin', user_type: 'system_admin', username: 'admin', created_at: 'now' },
            session_token: 'cs-session-token-that-is-long-enough',
            expires_at: 'later',
          },
        };
      },
    };
    const service = new PanelAuthService(config(), registry(), kernel);
    const result = await service.loginAdminApiKey('one', 'sk-mem-admin');
    expect(result.sessionToken).toMatch(/^cs-/);
    expect(calls).toEqual(['/v3/internal/meta/session/login-admin-api-key']);
  });

  it('maps rejected administrator API keys to unauthorized', async () => {
    const kernel: KernelHttpPort = {
      async postEnvelope() {
        return { code: 403, message: 'permission_denied', request_id: 'r1', data: null };
      },
    };
    const service = new PanelAuthService(config(), registry(), kernel);
    await expect(service.loginAdminApiKey('one', 'sk-mem-normal')).rejects.toMatchObject({ status: 401 });
  });

  it('sets an HttpOnly strict cookie on administrator API key login', async () => {
    const app = new Hono();
    registerAuthRoutes(app, {
      config: config(),
      authService: {
        ldapEnabled: false,
        async loginAdminApiKey() {
          return {
            user: { user_id: 'usr-admin', user_type: 'system_admin', username: 'admin', created_at: 'now' },
            sessionToken: 'cs-session-token-that-is-long-enough',
            expiresAt: 'later',
          };
        },
      },
    } as unknown as PanelDeps);
    const response = await app.request('/auth/admin-api-key/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'cbrain.test', origin: 'http://cbrain.test' },
      body: JSON.stringify({ instance_id: 'one', api_key: 'sk-mem-admin' }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('cbrain_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });
});
