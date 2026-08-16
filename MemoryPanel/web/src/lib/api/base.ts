/**
 * api/base.ts — API 基础设施。
 *
 * 对接文档（唯一权威）：
 *   - docs/architecture/09-new-panel-control-backend-design.md  新面板设计（Header 鉴权、登录流程）
 *   - docs/api/meta-api.openapi.yaml                            前端对接契约（机器可读）
 *
 * 规则（Cbrain Web Session）：
 *   - 元数据 CRUD 统一走 POST /api/v1/meta/{action}；
 *   - 前端只缓存 instance_id；HttpOnly Cookie 由浏览器自动携带；
 *     ⚠️ Header 名以 meta-api.openapi.yaml v1.1.0 为准：instance 的 Header 名是
 *     `X-Tdai-Service-Id`（不是早期版本用过的 `X-Metadata-Instance-Id`），改名后未同步
 *     会导致 Control 报 400 MISSING_INSTANCE_ID。
 *   - asset/* 域已放开（skill「分配到 Agent」走授权接口：先 asset/create 登记
 *     再 acl/grant）；agent-fixed-asset/*（运行时固定注入）仍 501 NOT_IN_SCOPE。
 *     注：PANEL_CAPABILITIES.assets 仍为 false —— 它只控制通用「资产」UI 是否展示
 *     占位，skill 挂载走 v3 数据面 fork（skillApi.forkToAgent），不受该开关影响；
 *   - LDAP / 应急登录统一换取 HttpOnly Web Session；
 *   - 所有函数返回 Promise<T>，失败抛 ApiError。
 */
import { getPanelSession, clearPanelSession } from '../panelSession';
import { formatApiErrorMessage } from '../error-message';
import type { MetaEnvelope, PaginatedResult, PublicUser } from './types';

/**
 * 通用「资产」能力开关。
 * UI 消费 assetsApi / agentsApi.getAssets|getFixedAssets|setFixedAssets 前应先判断
 * `PANEL_CAPABILITIES.assets`，为 false 时展示"暂未开放"占位，不要发起注定 501 的请求。
 */
export const PANEL_CAPABILITIES = {
  assets: false,
} as const;

// ========================= Error =========================

export class ApiError extends Error {
  public code?: number | string;
  public requestId?: string;
  public rawMessage?: string;

  constructor(
    public status: number,
    public statusText: string,
    public body: string,
    opts: { code?: number | string; requestId?: string; rawMessage?: string } = {}
  ) {
    super(formatApiErrorMessage({
      code: opts.code,
      message: opts.rawMessage ?? statusText,
      requestId: opts.requestId,
      httpStatus: status,
      httpStatusText: statusText,
      body,
    }));
    this.name = 'ApiError';
    this.code = opts.code;
    this.requestId = opts.requestId;
    this.rawMessage = opts.rawMessage ?? statusText;
  }
}

// ========================= Base Request =========================

const AUTH_UNAUTHORIZED_EVENT = 'auth:unauthorized';

/** 发出 401 事件，App 层监听后清 auth state 展示登录页 */
function emitUnauthorized() {
  window.dispatchEvent(new CustomEvent(AUTH_UNAUTHORIZED_EVENT));
}

/** 监听 401 事件 */
export function onUnauthorized(handler: () => void): () => void {
  window.addEventListener(AUTH_UNAUTHORIZED_EVENT, handler);
  return () => window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, handler);
}

function parseMetaErrorEnvelope(text: string): {
  code?: number | string;
  requestId?: string;
  rawMessage?: string;
} {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return {};
  try {
    const env = JSON.parse(trimmed) as MetaEnvelope<unknown>;
    if (typeof env?.message === 'string' && env.message.trim()) {
      return {
        code: env.code,
        requestId: env.request_id,
        rawMessage: env.message,
      };
    }
  } catch {
    /* non-JSON error body */
  }
  return {};
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<T> {
  const headers: Record<string, string> = { ...extraHeaders };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (res.status === 401) {
    emitUnauthorized();
    throw new ApiError(res.status, res.statusText, 'Unauthorized');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const env = parseMetaErrorEnvelope(text);
    throw new ApiError(res.status, res.statusText, text, env);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

// ========================= Meta API 基础 =========================

export const META_PREFIX = '/api/v1/meta';
export const META_PAGE_SIZE = 100;

/**
 * 登出 / 401 时清空前端实例选择和内存用户资料；主动登出由 auth store
 * 另外调用后端撤销 HttpOnly Web Session。
 */
export function clearSessionCache(): void {
  clearPanelSession();
}

/** 从当前会话取当前登录用户；未登录抛错（调用方应先保证已登录）。 */
export async function getCurrentUser(): Promise<PublicUser> {
  const session = getPanelSession();
  if (!session?.user) {
    throw new ApiError(401, 'Unauthorized', 'no active panel session');
  }
  return session.user;
}

/**
 * 内核 meta 透明代理的公共调用：注入指定 Header，POST body，解析信封。
 * 业务调用只显式传实例 Header；HttpOnly Cookie 由浏览器同源请求自动携带。
 */
export async function metaCall<T>(
  action: string,
  body: Record<string, unknown>,
  headers: Record<string, string>
): Promise<T> {
  const envelope = await request<MetaEnvelope<T>>('POST', `${META_PREFIX}/${action}`, body, headers);
  if (envelope.code !== 0) {
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  if (envelope.data === null || envelope.data === undefined) {
    throw new ApiError(200, envelope.message || 'empty meta response', '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message || 'empty meta response',
    });
  }
  return envelope.data;
}

export async function metaPost<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const session = getPanelSession();
  if (!session) {
    throw new ApiError(401, 'Unauthorized', 'no active panel session');
  }
  return metaCall<T>(action, body, {
    'X-Tdai-Service-Id': session.instanceId,
  });
}

export async function metaListAll<T>(action: string, body: Record<string, unknown>): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await metaPost<PaginatedResult<T>>(action, {
      ...body,
      limit: META_PAGE_SIZE,
      offset,
    });
    items.push(...page.items);
    offset += page.items.length;
    if (page.items.length === 0 || offset >= page.total) break;
  }
  return items;
}

/**
 * 「请求进行中去重」：同一 key 上一次发起尚未 settle 时，复用同一个 Promise，
 * 请求结束后立即从表中移除（不做结果缓存）。
 *
 * 用途：消除 React 18 StrictMode 开发态对 effect 的双调用、以及组件并发挂载
 * 造成的同一接口重复网络请求。
 *
 * 约束：只能用于**幂等只读**接口（list/get）。create/revoke 等写操作严禁复用，
 * 否则会把两次独立写合并成一次。
 */
const inFlightReads = new Map<string, Promise<unknown>>();
export function dedupeInFlight<T>(key: string, factory: () => Promise<T>): Promise<T> {
  const existing = inFlightReads.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = factory().finally(() => {
    inFlightReads.delete(key);
  });
  inFlightReads.set(key, p);
  return p;
}
