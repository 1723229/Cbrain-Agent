/**
 * 浏览器只持久化非敏感的实例选择；真正登录凭证由 HttpOnly Cookie 保存，
 * JavaScript 不可读取。用户公开资料只驻留当前页面内存，刷新后从 /auth/session 恢复。
 */
import type { PublicUser } from './teamApi';

export interface PanelSession {
  /** = 注册表 id = 内核 x-tdai-service-id；登录页选择实例时确定 */
  instanceId: string;
  /** 仅展示用（实例列表里的 name），非必需 */
  instanceName?: string;
  /** 当前页面内存中的公开资料，不写 localStorage。 */
  user?: PublicUser;
}

const STORAGE_KEY = 'tdai-panel.session';
let currentUser: PublicUser | undefined;

/** 读取当前会话；无会话或解析失败均返回 null（不抛错，调用方按未登录处理） */
export function getPanelSession(): PanelSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Pick<PanelSession, 'instanceId' | 'instanceName'>;
    return { ...stored, user: currentUser };
  } catch {
    return null;
  }
}

/** 登录成功（auth/verify 返回 valid===true）后写入会话 */
export function setPanelSession(session: PanelSession): void {
  currentUser = session.user;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      instanceId: session.instanceId,
      instanceName: session.instanceName,
    }));
  } catch {
    /* 隐私模式 / 存储配额异常：静默失败，不阻断登录后的本次会话内存态 */
  }
}

/** 登出 / 401 兜底时清空会话 */
export function clearPanelSession(): void {
  currentUser = undefined;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
