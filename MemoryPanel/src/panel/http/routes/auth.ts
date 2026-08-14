import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { PanelDeps } from '../../panel-deps.js';
import { PanelAuthenticationError } from '../../auth/panel-auth-service.js';

function originAllowed(c: Context): boolean {
  const origin = c.req.header('origin');
  if (!origin) return true;
  try {
    const expectedHost = c.req.header('x-forwarded-host')?.split(',')[0]?.trim() || c.req.header('host');
    return !!expectedHost && new URL(origin).host === expectedHost;
  } catch {
    return false;
  }
}

function setSessionCookie(c: Context, deps: PanelDeps, token: string): void {
  setCookie(c, deps.config.session.cookieName, token, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: deps.config.session.secure,
    path: '/',
    maxAge: deps.config.session.ttlSeconds,
  });
  c.header('Cache-Control', 'no-store');
}

function authError(c: Context, err: unknown) {
  if (err instanceof PanelAuthenticationError) {
    return c.json({ code: err.status, message: err.code, request_id: c.get('reqId') ?? '', data: null }, err.status);
  }
  throw err;
}

export function registerAuthRoutes(api: Hono, deps: PanelDeps): void {
  api.post('/auth/ldap/login', async (c) => {
    if (!originAllowed(c)) return c.json({ code: 403, message: 'INVALID_ORIGIN', data: null }, 403);
    if (!deps.authService.ldapEnabled) return c.json({ code: 404, message: 'LDAP_DISABLED', data: null }, 404);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    try {
      const result = await deps.authService.loginLdap(
        typeof body.instance_id === 'string' ? body.instance_id : '',
        typeof body.username === 'string' ? body.username : '',
        typeof body.password === 'string' ? body.password : '',
      );
      setSessionCookie(c, deps, result.sessionToken);
      return c.json({ code: 0, message: 'ok', data: { user: result.user, expires_at: result.expiresAt } });
    } catch (err) {
      return authError(c, err);
    }
  });

  api.post('/auth/admin-api-key/login', async (c) => {
    if (!originAllowed(c)) return c.json({ code: 403, message: 'INVALID_ORIGIN', data: null }, 403);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    try {
      const result = await deps.authService.loginAdminApiKey(
        typeof body.instance_id === 'string' ? body.instance_id : '',
        typeof body.api_key === 'string' ? body.api_key : '',
      );
      setSessionCookie(c, deps, result.sessionToken);
      return c.json({ code: 0, message: 'ok', data: { user: result.user, expires_at: result.expiresAt } });
    } catch (err) {
      return authError(c, err);
    }
  });

  api.get('/auth/session', async (c) => {
    c.header('Cache-Control', 'no-store');
    const instanceId = c.req.query('instance_id')?.trim() || '';
    const token = getCookie(c, deps.config.session.cookieName) ?? '';
    const user = instanceId && token ? await deps.authService.resolveSession(instanceId, token) : null;
    if (!user) return c.json({ code: 401, message: 'SESSION_INVALID', data: null }, 401);
    return c.json({ code: 0, message: 'ok', data: { user } });
  });

  api.post('/auth/logout', async (c) => {
    if (!originAllowed(c)) return c.json({ code: 403, message: 'INVALID_ORIGIN', data: null }, 403);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const instanceId = typeof body.instance_id === 'string' ? body.instance_id : '';
    const token = getCookie(c, deps.config.session.cookieName) ?? '';
    if (instanceId && token) await deps.authService.revokeSession(instanceId, token).catch(() => undefined);
    deleteCookie(c, deps.config.session.cookieName, { path: '/' });
    c.header('Cache-Control', 'no-store');
    return c.json({ code: 0, message: 'ok', data: { ok: true } });
  });
}
