import type { Hono } from 'hono';
import { isAllowedSkillAction } from '../../../api/skill-actions.js';
import type { PanelDeps } from '../../../panel-deps.js';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../../envelope.js';
import type { MetaCallContext } from '../../../kernel/types.js';

/**
 * 从请求路径中解析 skill action。
 * skill action 可能带二级路径（files/write、files/remove、files/read），
 * 故取 `/skill/` 之后的全部片段。
 */
function readAction(path: string): string {
  const marker = '/skill/';
  const idx = path.indexOf(marker);
  if (idx < 0) return '';
  return path.slice(idx + marker.length);
}

/**
 * 注册 skill 数据面透明代理：POST /api/v1/skill/{action} → 内核 POST /v3/skill/{action}。
 *
 * 统一 Session 中间件先解析可信用户；skill body 的 user_id 由服务端覆盖，
 * 不接受浏览器自报身份。
 */
export function registerSkillProxyRoutes(api: Hono, deps: PanelDeps): void {
  api.post('/skill/*', validatePanelMetaHeaders(deps), async (c) => {
    const action = readAction(c.req.path);
    if (!action || !isAllowedSkillAction(action)) {
      return respondControlError(c, 404, 'UNKNOWN_SKILL_ACTION');
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const panelMeta = c.get('panelMeta');
    body.user_id = panelMeta.user.user_id;
    if ('owner_user_id' in body) body.owner_user_id = panelMeta.user.user_id;
    const ctx: MetaCallContext = {
      instanceId: panelMeta.instanceId,
      gatewayEndpoint: panelMeta.gatewayEndpoint,
      gatewayApiKey: panelMeta.gatewayApiKey,
      userKey: panelMeta.userKey,
      userId: panelMeta.user.user_id,
      reqId: c.get('reqId'),
    };

    const envelope = await deps.skillKernel.invoke(action, body, ctx);
    return respondEnvelope(c, envelope);
  });
}
