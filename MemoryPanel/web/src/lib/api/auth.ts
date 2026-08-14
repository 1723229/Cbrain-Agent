/**
 * api/auth.ts — LDAP / 应急登录与 HttpOnly Web Session。
 */
import { request } from './base';
import type { PublicUser } from './types';

interface AuthEnvelope {
  code: number;
  message: string;
  data: { user: PublicUser; expires_at?: string } | null;
}

async function unwrapAuth(promise: Promise<AuthEnvelope>): Promise<PublicUser> {
  const envelope = await promise;
  if (envelope.code !== 0 || !envelope.data?.user) throw new Error(envelope.message || 'AUTH_FAILED');
  return envelope.data.user;
}

export const authSessionApi = {
  ldapLogin: (instanceId: string, username: string, password: string) => unwrapAuth(
    request<AuthEnvelope>('POST', '/api/v1/auth/ldap/login', { instance_id: instanceId, username, password }),
  ),
  adminApiKeyLogin: (instanceId: string, apiKey: string) => unwrapAuth(
    request<AuthEnvelope>('POST', '/api/v1/auth/admin-api-key/login', { instance_id: instanceId, api_key: apiKey }),
  ),
  session: (instanceId: string) => unwrapAuth(
    request<AuthEnvelope>('GET', `/api/v1/auth/session?instance_id=${encodeURIComponent(instanceId)}`),
  ),
  logout: (instanceId: string) => request<AuthEnvelope>('POST', '/api/v1/auth/logout', { instance_id: instanceId }),
};

// ========================= Environment Bindings =========================
//
// ⚠️ 新面板一期不注册 /api/v1/users/* 路由（09 设计文档 §6.1、§9 N1），
// 以下接口在新面板 Control 下会 404。保留代码是为了兼容仍跑在链路 B（Legacy）
// 的环境；若某个页面要切到新面板，请先隐藏/置灰调用这组接口的入口。

/**
 * 环境绑定（environment_bindings）：把用户在外部环境（CodeBuddy / Cursor 等）的
 * 外部 user_id 与本平台 user 关联，供 proxy 通过 (environment, environment_user_id)
 * 反查到团队 / agent / task。
 *
 * 唯一约束：(environment, environment_user_id) 全局唯一；被他人占用 → 409。
 */
export interface EnvironmentBinding {
  id: string;
  user_id: string;
  environment: string;
  environment_user_id: string;
  created_at: string;
  updated_at: string;
}

export const environmentBindingsApi = {
  /** 列出当前登录用户的全部绑定 */
  list: () => request<EnvironmentBinding[]>('GET', '/api/v1/users/me/environment-bindings'),

  /** 新增一条绑定（幂等：同 user 重复 POST 同样的 (env, env_user_id) 不报错） */
  create: (data: { environment: string; environment_user_id: string }) =>
    request<EnvironmentBinding>('POST', '/api/v1/users/me/environment-bindings', data),

  /** 删除一条绑定（只能删自己的；删别人 → 403） */
  remove: (id: string) => request<{ ok: boolean }>('DELETE', `/api/v1/users/me/environment-bindings/${id}`),
};
