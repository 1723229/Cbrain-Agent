/**
 * v3 内部元数据路由（/v3/internal/meta/*）。
 * 运维 / 控制面专用；不写入公开 MetadataClient。
 */
import type * as http from "node:http";
import type { ZodType } from "zod";
import {
  successEnvelope,
  errorEnvelope,
  resolveRequestId,
  makeRequestId,
} from "../../gateway/v2-router.js";
import { formatZodError, type ApiResponseEnvelope } from "../../gateway/v2-schemas.js";
import type { Logger } from "../../core/types.js";
import { MetadataService, MetadataError } from "../service/metadata-service.js";
import { extractInstanceId, normalizeInstanceIdForRoute } from "./instance.js";
import { resolvePagination } from "./pagination.js";
import {
  federatedLoginSchema,
  federatedSyncSchema,
  adminApiKeyLoginSchema,
  internalListUsersByInstanceSchema,
  initAdminSchema,
  internalOwnedAssetEnsureSchema,
  webSessionIssueSchema,
  webSessionTokenSchema,
} from "./v3-meta-schemas.js";
import { toPublicUser } from "../service/user-visibility.js";
import {
  createMetaApiTraceContext,
  logMetaApiEntry,
  logMetaApiError,
  logMetaApiRejected,
  logMetaApiResponse,
} from "./meta-api-trace.js";
import {
  getApiTraceConfig,
  runWithApiRequestContext,
} from "../../api-trace/index.js";

export const V3_INTERNAL_PREFIX = "/v3/internal/meta";

const TAG = "[META-V3-INTERNAL]";

export interface InternalMetaRouterDeps {
  getMetadataService: (instanceId: string) => MetadataService | undefined | Promise<MetadataService | undefined>;
  logger: Logger;
}

type InternalHandler = (
  body: unknown,
  svc: MetadataService,
  instanceId: string,
  requestId: string,
) => Promise<ApiResponseEnvelope>;

function bind<S extends ZodType>(
  schema: S,
  fn: (data: S["_output"], svc: MetadataService, instanceId: string) => Promise<unknown>,
): InternalHandler {
  return async (body, svc, instanceId, requestId) => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
    const data = await fn(parsed.data as S["_output"], svc, instanceId);
    return successEnvelope(data, requestId);
  };
}

const routeTable: Record<string, InternalHandler> = {
  [`${V3_INTERNAL_PREFIX}/user/init-admin`]: bind(initAdminSchema, (d, svc) => svc.initAdminUser(d)),
  [`${V3_INTERNAL_PREFIX}/user/list-by-instance`]: bind(
    internalListUsersByInstanceSchema,
    async (d, svc, instanceId) => {
      const pagination = resolvePagination(d);
      return svc.listUsersByInstance(instanceId, pagination, {
        status: d.status,
        user_type: d.user_type,
        user_ids: d.user_ids,
      });
    },
  ),
  [`${V3_INTERNAL_PREFIX}/federated/login`]: bind(federatedLoginSchema, (d, svc) =>
    svc.loginFederatedUser(d, { ttlSeconds: d.ttl_seconds }),
  ),
  [`${V3_INTERNAL_PREFIX}/session/login-admin-api-key`]: bind(adminApiKeyLoginSchema, (d, svc) =>
    svc.loginSystemAdminWithApiKey(d.api_key, d.ttl_seconds),
  ),
  [`${V3_INTERNAL_PREFIX}/session/issue`]: bind(webSessionIssueSchema, async (d, svc) => {
    const user = await svc.getUserById(d.user_id);
    if (!user) throw new MetadataError("user_not_found", `user not found: ${d.user_id}`);
    if (user.user_type !== "system_admin") {
      throw new MetadataError("permission_denied", "recovery session requires system_admin");
    }
    const session = await svc.issueWebSession(user.user_id, d.provider_id, d.ttl_seconds);
    return {
      user: toPublicUser(user, {
        token: session.session_token,
        userId: user.user_id,
        isAdmin: false,
        isSystemAdmin: true,
      }),
      ...session,
    };
  }),
  [`${V3_INTERNAL_PREFIX}/session/resolve`]: bind(webSessionTokenSchema, async (d, svc) => {
    const user = await svc.resolveWebSession(d.session_token);
    if (!user) throw new MetadataError("session_not_found", "session is invalid or expired");
    return {
      user: toPublicUser(user, {
        token: d.session_token,
        userId: user.user_id,
        isAdmin: false,
        isSystemAdmin: user.user_type === "system_admin",
      }),
    };
  }),
  [`${V3_INTERNAL_PREFIX}/session/revoke`]: bind(webSessionTokenSchema, async (d, svc) => {
    await svc.revokeWebSession(d.session_token);
    return { ok: true };
  }),
  [`${V3_INTERNAL_PREFIX}/asset/ensure-owned`]: bind(internalOwnedAssetEnsureSchema, (d, svc) =>
    svc.ensureOwnedAssetInternal({
      ...d,
      content_ref: d.content_ref ?? undefined,
      status: "approved",
    }),
  ),
  [`${V3_INTERNAL_PREFIX}/federated/sync`]: bind(federatedSyncSchema, (d, svc) =>
    svc.syncFederatedUsers(d.provider_id, d.users),
  ),
};

export const V3_INTERNAL_ROUTES = Object.keys(routeTable);

function mapErrorCode(code: string): number {
  if (code === "invalid_credentials") return 401;
  if (code.endsWith("_not_found")) return 404;
  if (code === "permission_denied") return 403;
  if (code === "missing_instance_id" || code === "invalid_instance_id") return 400;
  if (code === "already_initialized" || code === "last_system_admin" || code === "member_already_exists") return 409;
  if (code === "user_limit_exceeded" || code === "team_limit_exceeded") return 409;
  return 400;
}

function resolveInstanceId(req: http.IncomingMessage, bodyInstance?: string): string {
  try {
    const fromHeader = extractInstanceId(req.headers);
    if (fromHeader) return fromHeader;
  } catch {
    /* fall through */
  }
  return bodyInstance?.trim() ?? "";
}

/**
 * 内部分发：仅 Bearer（Layer 1 已在 gateway 校验）；跳过 x-tdai-user-key。
 */
export async function handleInternalMetaRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  parseJsonBody: <T>(req: http.IncomingMessage) => Promise<T>,
  sendJson: (res: http.ServerResponse, status: number, body: unknown) => void,
  deps: InternalMetaRouterDeps,
): Promise<boolean> {
  if (!pathname.startsWith(V3_INTERNAL_PREFIX) || method !== "POST") return false;

  const handler = routeTable[pathname];
  if (!handler) {
    sendJson(res, 404, errorEnvelope(404, "not_found", makeRequestId()));
    return true;
  }

  const requestId = resolveRequestId(req.headers as Record<string, string | string[] | undefined>);
  const traceCtx = createMetaApiTraceContext({ route: pathname, requestId, internal: true });

  try {
    const body = await parseJsonBody<Record<string, unknown>>(req);
    const bodyInstance =
      typeof body.instance_id === "string" ? body.instance_id : undefined;
    let instanceId: string;
    try {
      instanceId = normalizeInstanceIdForRoute(resolveInstanceId(req, bodyInstance));
    } catch (err) {
      if (err instanceof MetadataError) {
        const code = mapErrorCode(err.code);
        logMetaApiRejected(traceCtx, {
          httpStatus: code,
          envelopeCode: code,
          message: err.code,
          body,
        });
        sendJson(res, code, errorEnvelope(code, err.code, requestId));
        return true;
      }
      throw err;
    }
    traceCtx.instanceId = instanceId;

    const svc = await Promise.resolve(deps.getMetadataService(instanceId));
    if (!svc) {
      logMetaApiRejected(traceCtx, {
        httpStatus: 503,
        envelopeCode: 503,
        message: "MetadataService not available",
        body,
      });
      sendJson(res, 503, errorEnvelope(503, "MetadataService not available", requestId));
      return true;
    }

    const traceModule = getApiTraceConfig().policy.module;
    await runWithApiRequestContext(
      {
        requestId,
        route: pathname,
        module: traceModule,
        instanceId,
        internal: true,
      },
      async () => {
        logMetaApiEntry(traceCtx, body);
        deps.logger.debug?.(`${TAG} ${pathname} instance=${instanceId}`);
        const envelope = await handler(body, svc, instanceId, requestId);
        const httpStatus = envelope.code === 0 ? 200 : envelope.code >= 400 && envelope.code < 600 ? envelope.code : 200;
        logMetaApiResponse(traceCtx, envelope, httpStatus);
        sendJson(res, httpStatus, envelope);
      },
    );
    return true;
  } catch (err) {
    if (err instanceof MetadataError) {
      const code = mapErrorCode(err.code);
      const message = `${err.code}: ${err.message}`;
      logMetaApiError(traceCtx, err, { envelopeCode: code, httpStatus: code });
      sendJson(res, code, errorEnvelope(code, message, requestId));
      return true;
    }
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger.error?.(`${TAG} unexpected: ${msg}`);
    logMetaApiError(traceCtx, err, { envelopeCode: 500, httpStatus: 500 });
    sendJson(res, 500, errorEnvelope(500, "internal_error", requestId));
    return true;
  }
}
