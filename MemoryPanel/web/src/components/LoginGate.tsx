/**
 * LoginGate — 进入应用前的登录页面（对接新面板 Control，见 09 设计文档 §3.3）。
 *
 * 登录流程：选择实例后使用 LDAP（主路径）或系统管理员 API Key（break-glass）登录；
 * 后端签发 HttpOnly Cookie。localStorage 只保存非敏感的实例选择，公开用户资料
 * 仅驻留页面内存并在刷新后通过 /auth/session 恢复。
 *
 * 设计：保留原有左右分栏视觉（左侧深色插图 + 右侧表单），
 * 把旧的浏览器 user_key 登录替换为服务端 LDAP/Web Session。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select, Input, Button, Alert } from 'tea-component';
import { authSessionApi, metaInstancesApi, type MetadataInstance, type PublicUser } from '@/lib/teamApi';
import { getPanelSession, setPanelSession, clearPanelSession } from '@/lib/panelSession';
import './login-gate.css';

export interface AuthState {
  /** 展示用用户名（display_name || username），沿用旧字段名保持下游组件兼容 */
  user: string;
  /** 后端 ULID —— 一切归属判定（owner_user_id / creator_user_id / team_members.user_id）的真正 key */
  user_id: string;
  instance_id: string;
  instance_name: string;
  loggedInAt: number;
  /**
   * 是否是全局 admin —— 来自 auth/verify 响应 data.user.user_type === 'system_admin'。
   * admin 是全局角色，与是否创建/加入任何 team 无关（管团队，不管资源）；
   * 非 admin 的普通用户（user_type !== 'system_admin'）才需要按 team.members 表查角色。
   */
  isAdmin: boolean;
}

// 内存缓存 —— 真正的持久化交给 localStorage（lib/panelSession.ts，跨 tab 共享）。
// 这里只是给「无 prop、直接 readAuth() 取身份」的老组件（ChatMemoryPanel / WikiSourcesPanel /
// CodeSourcesPanel 等）提供一个同步读取的镜像缓存。
let _authCache: AuthState | null = null;

export function readAuth(): AuthState | null {
  return _authCache;
}

/** 登出 / 401 兜底：同时清内存镜像缓存与 localStorage 里的实例选择。 */
export function clearAuth(): void {
  _authCache = null;
  clearPanelSession();
}

function writeAuthCache(auth: AuthState): void {
  _authCache = auth;
}

function toAuthState(user: PublicUser, instanceId: string, instanceName: string): AuthState {
  return {
    user: user.display_name || user.username,
    user_id: user.user_id,
    instance_id: instanceId,
    instance_name: instanceName,
    loggedInAt: Date.now(),
    isAdmin: user.user_type === 'system_admin',
  };
}

/**
 * 使用 localStorage 里的实例选择和 HttpOnly Cookie 向后端恢复登录态。
 * App 启动时调用；成功则写入内存镜像缓存并返回，失败（未登录/缓存不全）返回 null。
 */
export async function resumeSession(): Promise<AuthState | null> {
  const session = getPanelSession();
  if (!session?.instanceId) return null;
  try {
    const user = await authSessionApi.session(session.instanceId);
    setPanelSession({ ...session, user });
    const auth = toAuthState(user, session.instanceId, session.instanceName ?? '');
    writeAuthCache(auth);
    return auth;
  } catch {
    clearPanelSession();
    return null;
  }
}

/** Cbrain 极简品牌主视觉。 */
function HeroIllustration() {
  return (
    <div aria-hidden="true" className="cbrain-login-hero relative h-[min(320px,42vh)] w-[min(480px,68vw)]">
      <div className="cbrain-login-hero__glow absolute inset-8 rounded-full bg-blue-500/10 blur-3xl" />
      <div className="cbrain-login-hero__orbit cbrain-login-hero__orbit--outer h-52 w-52 rounded-full border border-blue-300/10">
        <span className="cbrain-login-hero__dot cbrain-login-hero__dot--cyan" />
      </div>
      <div className="cbrain-login-hero__orbit cbrain-login-hero__orbit--inner h-36 w-36 rounded-full border border-blue-300/15">
        <span className="cbrain-login-hero__dot cbrain-login-hero__dot--blue" />
      </div>
      <div className="cbrain-login-hero__core absolute left-1/2 top-1/2 h-24 w-24 rounded-[28px] border border-white/10 bg-white/[0.04] shadow-[0_20px_70px_rgba(37,99,235,0.22)] backdrop-blur-sm">
        <img src="/cbrain-mark.svg" alt="" className="h-full w-full p-5" />
      </div>
    </div>
  );
}

export default function LoginGate({
  onLoggedIn,
}: {
  onLoggedIn: (auth: AuthState) => void;
}) {
  const { t } = useTranslation();
  const [instances, setInstances] = useState<MetadataInstance[]>([]);
  const [instanceId, setInstanceId] = useState('');
  const [loginMode, setLoginMode] = useState<'ldap' | 'adminApiKey'>('ldap');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [adminApiKey, setAdminApiKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instancesError, setInstancesError] = useState(false);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    metaInstancesApi
      .list()
      .then((list) => {
        if (cancelled) return;
        setInstancesError(false);
        setInstances(list);
        if (list.length > 0) setInstanceId(list[0].instance_id);
      })
      .catch((err) => {
        if (cancelled) return;
        setInstancesError(true);
        setError(t('login.error.loadInstances', { detail: err instanceof Error ? ` (${err.message})` : '' }));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!instanceId) {
      setError(t('login.error.selectInstance'));
      return;
    }
    if (loginMode === 'ldap' && (!username.trim() || !password)) {
      setError(t('login.error.emptyCredentials'));
      return;
    }
    if (loginMode === 'adminApiKey' && !adminApiKey.trim()) {
      setError(t('login.error.emptyAdminApiKey'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const user = loginMode === 'ldap'
        ? await authSessionApi.ldapLogin(instanceId, username.trim(), password)
        : await authSessionApi.adminApiKeyLogin(instanceId, adminApiKey.trim());
      const instance = instances.find((i) => i.instance_id === instanceId) ?? null;
      setPanelSession({ instanceId, instanceName: instance?.name, user });
      const auth = toAuthState(user, instanceId, instance?.name ?? '');
      writeAuthCache(auth);
      onLoggedIn(auth);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex">
      {/* ====== 左侧深色面板 ====== */}
      <div className="hidden lg:flex flex-col flex-1 bg-[#0b1120] relative overflow-hidden">
        <div className="flex items-center gap-2.5 px-6 py-5">
          <img src="/cbrain-mark.svg" alt="Cbrain" className="h-8 w-8" />
          <span className="text-[15px] font-semibold text-white/90 tracking-wide">Cbrain</span>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center px-8">
          <HeroIllustration />
          <h2 className="mt-8 text-xl font-semibold text-white/90 tracking-wide">
            Cbrain
          </h2>
          <p className="mt-2 text-sm text-slate-400 text-center max-w-xs">
            {t('login.tagline')}
          </p>
        </div>

      </div>

      {/* ====== 右侧登录表单面板 ====== */}
      <div className="w-full lg:w-[480px] xl:w-[520px] flex flex-col bg-white dark:bg-[#0f172a] overflow-y-auto">
        <div className="flex lg:hidden items-center gap-2.5 px-6 py-4 border-b border-slate-200 dark:border-slate-700">
          <img src="/cbrain-mark.svg" alt="Cbrain" className="h-7 w-7" />
          <span className="text-[14px] font-semibold text-slate-800 dark:text-white/90">
            Cbrain
          </span>
        </div>

        <div className="flex-1 flex flex-col justify-center px-8 sm:px-12 lg:px-14 py-10">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white/95">{t('login.welcome')}</h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            {t('login.subtitle')}
          </p>

          <form onSubmit={submit} className="mt-8 _tdai-login-form">
            {/* 记忆实例选择 — GET /api/v1/meta/instances */}
            <Select
              appearance="button"
              size="full"
              value={instanceId}
              onChange={(value) => {
                setInstanceId(value);
                setError(null);
              }}
              disabled={submitting || instances.length === 0}
              placeholder={instancesError ? t('login.placeholder.instanceError') : t('login.placeholder.instance')}
              options={instances.map((inst) => ({ value: inst.instance_id, text: inst.name }))}
            />

            {loginMode === 'ldap' ? (
              <>
                <Input
                  autoFocus
                  size="full"
                  value={username}
                  onChange={(value) => { setUsername(value); setError(null); }}
                  placeholder={t('login.placeholder.username')}
                  autoComplete="username"
                  disabled={submitting}
                />
                <Input.Password
                  size="full"
                  value={password}
                  onChange={(value) => { setPassword(value); setError(null); }}
                  placeholder={t('login.placeholder.password')}
                  autoComplete="current-password"
                  disabled={submitting}
                  rules={false}
                />
              </>
            ) : (
              <Input.Password
                autoFocus
                size="full"
                value={adminApiKey}
                onChange={(value) => { setAdminApiKey(value); setError(null); }}
                placeholder={t('login.placeholder.adminApiKey')}
                autoComplete="off"
                disabled={submitting}
                rules={false}
              />
            )}

            {error && <Alert type="error">{error}</Alert>}

            <Button type="primary"
              htmlType="submit"
              className="_tdai-login-submit"
              loading={submitting}
              disabled={submitting || !instanceId || (loginMode === 'ldap'
                ? !username.trim() || !password
                : !adminApiKey.trim())}
            >
              {submitting ? t('login.submitting') : t('login.submit')}
            </Button>
            <Button
              type="link"
              disabled={submitting}
              onClick={() => {
                setLoginMode((mode) => mode === 'ldap' ? 'adminApiKey' : 'ldap');
                setError(null);
              }}
            >
              {loginMode === 'ldap' ? t('login.useAdminApiKey') : t('login.useLdap')}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
