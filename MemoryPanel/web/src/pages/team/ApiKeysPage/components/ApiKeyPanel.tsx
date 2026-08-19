/**
 * ApiKeyPanel — User_Key 管理（组织与权限分组）。
 *
 * 精简版：列表只展示 4 个核心字段——key_id / user_id / key_prefix / 创建时间，
 * 不再展示「名称」「过期时间」两列（对应地，新建弹窗也不再要求填写名称）。
 * Tea 组件：列表用 Table + autotip，头部用 Justify + H3，
 * 破坏性操作统一走 Modal.confirm 二次确认，新建弹窗复用全站统一的 Modal 外壳。
 *
 * 后端链路：新面板（stateless）走 meta action `user-key/list|create|revoke`，
 * 由 Control 透明代理到内核 /v3/meta。前端不直接调内核，也不走旧 REST 路径。
 * owner 由登录 user_key 推断，前端不用也不能传别人的 user_id —— 天然满足
 * 「用户只能看到 / 管理自己的 key」。
 *
 * 当前用户自己的列表返回完整 key_value，可随时查看和复制；管理员代查他人时
 * 仍只返回 key_prefix。
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Moment } from 'moment';
import moment from 'moment';
import {
  Table,
  Card,
  Button,
  Copy,
  Text,
  DatePicker,
  Justify,
  H3,
  Form,
  Modal,
} from 'tea-component';
import { AddIcon } from 'tea-icons-react';
import { userKeysApi, metaInstancesApi, type UserKey } from '@/lib/teamApi';
import { useCurrentRole } from '@/services/useCurrentRole';
import { useAuthStore } from '@/stores/auth';
import { tea } from '@/lib/tea-bridge';
import './api-key-panel.css';

const { autotip } = Table.addons;
const CBRAIN_AGENT_INSTALLER_VERSION = '0.1.5';

export default function ApiKeyPanel() {
  const { t } = useTranslation();
  const role = useCurrentRole();
  const { auth } = useAuthStore();
  const [keys, setKeys] = useState<UserKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [agentGatewayUrl, setAgentGatewayUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!auth?.instance_id) {
      setAgentGatewayUrl(null);
      return;
    }
    void metaInstancesApi
      .list()
      .then((list) => {
        if (cancelled) return;
        const hit = list.find((i) => i.instance_id === auth.instance_id);
        setAgentGatewayUrl(hit?.agent_gateway_endpoint ?? null);
      })
      .catch(() => {
        if (!cancelled) setAgentGatewayUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [auth?.instance_id]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await userKeysApi.list();
      // 按创建时间倒序（内核未必保证顺序）
      list.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
      // 已吊销的 key 不再展示
      setKeys(list.filter((k) => !k.revoked_at));
    } catch (e) {
      tea.notify.error(e);
      setKeys([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ---- 新建弹窗 ----
  // 不再收集「名称」——列表本身也不展示名称列，创建时无需再让用户填写。
  const [showCreate, setShowCreate] = useState(false);
  const [newExpiresAt, setNewExpiresAt] = useState<Moment | null>(null);
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    setCreating(true);
    try {
      const key = await userKeysApi.create({
        expires_at: newExpiresAt ? newExpiresAt.endOf('day').toISOString() : undefined,
      });
      setNewExpiresAt(null);
      setShowCreate(false);
      void key;
      await refresh();
    } catch (e) {
      tea.notify.error(e);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(key: UserKey) {
    const ok = await tea.confirm({
      message: t('apiKey.confirm.revoke', { name: key.key_prefix || key.key_id }),
      description: t('apiKey.confirm.revoke.desc'),
      okText: t('apiKey.confirm.revoke.ok'),
    });
    if (!ok) return;
    try {
      await userKeysApi.revoke(key.key_id);
      await refresh();
    } catch (e) {
      tea.notify.error(e);
    }
  }

  const formatTime = (iso?: string) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  return (
    <div className="_memory-apikey-body">
      {/* ===== 页面头部（Justify 左右布局） ===== */}
      <Justify
        left={
          <div>
            <H3>{t('apiKey.title')}</H3>
            <Text theme="text" parent="div" style={{ marginTop: 4 }}>
              {t('apiKey.desc')}
            </Text>
          </div>
        }
        right={
          role !== 'admin' ? (
            <Button
              type="primary"
              onClick={() => {
                setShowCreate(true);
                setNewExpiresAt(null);
              }}
              data-guide="create-key"
            >
              <AddIcon size={14} />
              {t('apiKey.create')}
            </Button>
          ) : null
        }
      />

      {/* ===== Key 列表：key_id / key_prefix / 创建时间 + 操作 ===== */}
      <Card>
        <Table
          verticalTop
          records={keys}
          recordKey="key_id"
          columns={[
            {
              key: 'key_id',
              header: t('apiKey.table.keyId'),
              render: (key) => (
                <Text
                  parent="code"
                  copyable
                  style={{
                    fontSize: 12,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 2,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {key.key_id}
                </Text>
              ),
            },
            {
              key: 'key_value',
              header: t('apiKey.table.keyValue'),
              render: (key) => (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, maxWidth: 520 }}>
                  <code style={{ fontSize: 12, wordBreak: 'break-all' }}>
                    {key.key_value || key.key_prefix || '—'}
                  </code>
                  {key.key_value ? <Copy text={key.key_value} /> : null}
                </div>
              ),
            },
            {
              key: 'created_at',
              header: t('apiKey.table.createdAt'),
              width: 180,
              render: (key) => <Text theme="text">{formatTime(key.created_at)}</Text>,
            },
            {
              key: 'expires_at',
              header: t('apiKey.table.expiresAt'),
              width: 180,
              render: (key) => {
                if (key.revoked_at) return <Text theme="weak">{t('apiKey.revoked')}</Text>;
                return key.expires_at ? (
                  <Text theme="text">{formatTime(key.expires_at)}</Text>
                ) : (
                  <Text theme="weak">{t('apiKey.neverExpire')}</Text>
                );
              },
            },
            {
              key: 'actions',
              header: t('apiKey.table.actions'),
              width: 100,
              align: 'right',
              render: (key) => (
                <Button
                  type="text"
                  disabled={!!key.revoked_at}
                  onClick={() => void handleDelete(key)}
                >
                  {t('apiKey.revoke')}
                </Button>
              ),
            },
          ]}
          addons={[
            autotip({
              isLoading: loading,
              emptyText: (
                <div className="_memory-apikey-empty">
                  <div className="_memory-apikey-empty-title">{t('apiKey.empty.title')}</div>
                  <div className="_memory-apikey-empty-desc">{t('apiKey.empty.desc')}</div>
                </div>
              ),
              onRetry: () => void refresh(),
            }),
          ]}
        />
      </Card>

      {agentGatewayUrl && (
        <Card>
          <Card.Body title={t('apiKey.plugin.title')}>
            <Text theme="weak" parent="div" style={{ marginBottom: 12 }}>
              {t('apiKey.plugin.desc')}
            </Text>
            <div style={{ marginBottom: 16, padding: '12px 16px', background: 'var(--tea-color-bg-secondary-default)', borderRadius: 4 }}>
              <Text theme="label" parent="div" style={{ marginBottom: 8 }}>{t('apiKey.plugin.flow.title')}</Text>
              <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8 }}>
                <li><strong>{t('apiKey.plugin.flow.install.title')}</strong>：{t('apiKey.plugin.flow.install.desc')}</li>
                <li><strong>{t('apiKey.plugin.flow.update.title')}</strong>：{t('apiKey.plugin.flow.update.desc')}</li>
                <li><strong>{t('apiKey.plugin.flow.uninstall.title')}</strong>：{t('apiKey.plugin.flow.uninstall.desc')}</li>
              </ol>
            </div>
            {(['codex', 'claude-code'] as const).map((client) => {
              const installerUrl = `"${window.location.origin}/downloads/cbrain-agent.tgz?v=${CBRAIN_AGENT_INSTALLER_VERSION}"`;
              const commands = [
                {
                  action: 'install',
                  label: t('apiKey.plugin.installOrUpdate'),
                  command: `npx --yes ${installerUrl} install ${client} --gateway ${agentGatewayUrl.replace(/\/+$/, '')}`,
                },
                {
                  action: 'uninstall',
                  label: t('apiKey.plugin.uninstall'),
                  command: `npx --yes ${installerUrl} uninstall ${client}`,
                },
              ];
              return (
                <div className="_memory-apikey-endpoint" key={client}>
                  <Text theme="label" parent="div" style={{ marginBottom: 4 }}>
                    {client === 'codex' ? 'Codex' : 'Claude Code'}
                  </Text>
                  {commands.map(({ action, label, command }) => (
                    <div key={action} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: action === 'uninstall' ? 6 : 0 }}>
                      <Text theme="weak" style={{ width: 72, flexShrink: 0 }}>{label}</Text>
                      <code style={{ flex: 1, fontSize: 11, wordBreak: 'break-all', background: 'var(--tea-color-bg-secondary-default)', padding: '4px 8px', borderRadius: 4 }}>
                        {command}
                      </code>
                      <Copy text={command}><Button>{t('apiKey.endpoint.copy')}</Button></Copy>
                    </div>
                  ))}
                </div>
              );
            })}
          </Card.Body>
        </Card>
      )}
      {/* ===== 新建弹窗：只需设置「过期时间」（可留空＝永不过期），不再需要名称 ===== */}
      {showCreate && (
        <Modal
          visible
          caption={t('apiKey.create.caption')}
          size="s"
          onClose={() => setShowCreate(false)}
          disableEscape={creating}
        >
          <Modal.Body>
            <Form>
              <Form.Item
                label={t('apiKey.create.expiresAt')}
                extra={t('apiKey.create.expiresAt.extra')}
              >
                <DatePicker
                  value={newExpiresAt ?? undefined}
                  onChange={(v) => setNewExpiresAt(v)}
                  disabledDate={(d) => !d.isBefore(moment().startOf('day'))}
                  placeholder={t('apiKey.create.expiresAt.placeholder')}
                />
              </Form.Item>
            </Form>
          </Modal.Body>
          <Modal.Footer>
            <Button
              type="primary"
              onClick={() => void handleCreate()}
              disabled={creating}
              loading={creating}
            >
              {t('apiKey.create.submit')}
            </Button>
            <Button onClick={() => setShowCreate(false)} disabled={creating}>
              {t('apiKey.create.cancel')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </div>
  );
}
