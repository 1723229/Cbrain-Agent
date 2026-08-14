import { createMiddleware } from 'hono/factory';
import { InstanceRegistryError } from '../../config/instance-registry.js';
import {
  META_HEADER_SERVICE_ID,
} from '../../kernel/headers.js';
import type { PanelDeps } from '../../panel-deps.js';
import { respondControlError } from '../envelope.js';
import { getCookie } from 'hono/cookie';
import type { PublicUser } from '../../../web-shared/public-user.js';

export interface PanelMetaContext {
  instanceId: string;
  gatewayEndpoint: string;
  gatewayApiKey: string;
  userKey?: string;
  user: PublicUser;
}

declare module 'hono' {
  interface ContextVariableMap {
    panelMeta: PanelMetaContext;
  }
}

export function validatePanelMetaHeaders(deps: PanelDeps) {
  return createMiddleware(async (c, next) => {
    const instanceId = c.req.header(META_HEADER_SERVICE_ID)?.trim();
    if (!instanceId) {
      return respondControlError(c, 400, 'MISSING_INSTANCE_ID');
    }

    let entry;
    try {
      entry = deps.instanceRegistry.resolve(instanceId);
    } catch (err) {
      if (err instanceof InstanceRegistryError && err.code === 400) {
        return respondControlError(c, 400, 'INVALID_INSTANCE');
      }
      throw err;
    }

    const sessionToken = getCookie(c, deps.config.session.cookieName) ?? '';
    if (!sessionToken) return respondControlError(c, 401, 'SESSION_REQUIRED');
    const user = await deps.authService.resolveSession(entry.instance_id, sessionToken);
    if (!user) return respondControlError(c, 401, 'SESSION_INVALID');

    c.set('panelMeta', {
      instanceId: entry.instance_id,
      gatewayEndpoint: entry.gateway_endpoint,
      gatewayApiKey: entry.api_key,
      userKey: sessionToken,
      user,
    });
    await next();
  });
}
