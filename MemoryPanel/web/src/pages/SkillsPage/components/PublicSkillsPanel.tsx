import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Input, Segment, Tag } from 'tea-component';

import { MarkdownView } from '@/components/MarkdownView';
import { listSkills } from '@/lib/api/skill-api';
import {
  publicSkillApi,
  type PublicSkillDocument,
  type PublicSkillItem,
  type PublicSkillJob,
} from '@/lib/public-skill-api';
import { tea } from '@/lib/tea-bridge';
import { PublicSkillDetail } from './PublicSkillDetail';
import './public-skills-panel.css';

type Layer = 'core' | 'extension';

export function PublicSkillsPanel(props: {
  teamId: string;
  selectedAgent: string;
  isSystemAdmin: boolean;
  canManageTeam: boolean;
}) {
  const [items, setItems] = useState<PublicSkillItem[]>([]);
  const [documents, setDocuments] = useState<PublicSkillDocument[]>([]);
  const [status, setStatus] = useState<Record<string, unknown>>({});
  const [selected, setSelected] = useState('');
  const [selectedDocument, setSelectedDocument] = useState('core');
  const [layer, setLayer] = useState<Layer>('core');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [installedRefresh, setInstalledRefresh] = useState(0);
  const [installed, setInstalled] = useState<
    Record<string, { contentHash: string; version: number }>
  >({});
  const [packKeys, setPackKeys] = useState<string[]>([]);
  const [itemIds, setItemIds] = useState<string[]>([]);
  const [savedPackKeys, setSavedPackKeys] = useState<string[]>([]);
  const [savedItemIds, setSavedItemIds] = useState<string[]>([]);
  const [packJob, setPackJob] = useState<PublicSkillJob | null>(null);
  const [busyPack, setBusyPack] = useState('');

  const load = useCallback(
    async (queryValue: string) => {
      setLoading(true);
      try {
        const [list, source, docs, policy] = await Promise.all([
          publicSkillApi.list(queryValue),
          publicSkillApi.status(),
          publicSkillApi.documents(),
          props.teamId
            ? publicSkillApi.getPolicy(props.teamId)
            : Promise.resolve({ pack_keys: [], item_ids: [] }),
        ]);
        setItems(list.items);
        setStatus(source);
        setDocuments(docs);
        setPackKeys(policy.pack_keys);
        setItemIds(policy.item_ids);
        setSavedPackKeys(policy.pack_keys);
        setSavedItemIds(policy.item_ids);
      } catch (error) {
        tea.notify.error(error);
      } finally {
        setLoading(false);
      }
    },
    [props.teamId],
  );

  const refresh = () => load(query);
  useEffect(() => {
    void load('');
  }, [load]);
  useEffect(() => {
    setPackJob(null);
    setBusyPack('');
  }, [props.selectedAgent]);

  useEffect(() => {
    if (!props.teamId || !props.selectedAgent) {
      setInstalled({});
      return;
    }
    void listSkills({
      team_id: props.teamId,
      filters: { owner_agent_id: props.selectedAgent, status: ['active'] },
      pagination: { limit: 1000 },
    })
      .then((result) => {
        const next: Record<string, { contentHash: string; version: number }> = {};
        for (const skill of result.items) {
          const origin = skill.metadata?.catalog_origin as
            { item_id?: string; content_hash?: string } | undefined;
          if (origin?.item_id)
            next[origin.item_id] = {
              contentHash: origin.content_hash ?? '',
              version: skill.version,
            };
        }
        setInstalled(next);
      })
      .catch(() => setInstalled({}));
  }, [props.teamId, props.selectedAgent, installedRefresh]);

  useEffect(() => {
    if (!packJob || !['pending', 'running'].includes(packJob.status)) return;
    const timer = window.setTimeout(() => {
      void publicSkillApi
        .jobStatus(packJob.job_id)
        .then((next) => {
          setPackJob(next);
          if (next.status === 'completed' || next.status === 'partial') {
            setBusyPack('');
            setInstalledRefresh((value) => value + 1);
          }
        })
        .catch((error) => {
          setBusyPack('');
          tea.notify.error(error);
        });
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [packJob]);

  const current = useMemo(
    () => items.find((item) => item.item_id === selected) ?? null,
    [items, selected],
  );
  const currentDocument = useMemo(
    () => documents.find((document) => document.document_key === selectedDocument) ?? null,
    [documents, selectedDocument],
  );
  const coreItems = useMemo(() => items.filter((item) => item.layer === 'core'), [items]);
  const extensionPacks = useMemo(() => {
    const grouped = new Map<string, PublicSkillItem[]>();
    for (const item of items.filter(
      (candidate) => candidate.layer === 'extension' && candidate.pack_key,
    )) {
      grouped.set(item.pack_key!, [...(grouped.get(item.pack_key!) ?? []), item]);
    }
    return Array.from(grouped.entries()).sort(([left], [right]) => left.localeCompare(right));
  }, [items]);
  const installedCurrent = current ? installed[current.item_id] : undefined;
  const partitionStates = useMemo(
    () =>
      new Map(
        (Array.isArray(status.partitions) ? status.partitions : []).map((entry) => {
          const value = entry as { partition_key?: string; status?: string };
          return [value.partition_key ?? '', value.status ?? 'unknown'];
        }),
      ),
    [status.partitions],
  );
  const policyDirty =
    JSON.stringify([...packKeys].sort()) !== JSON.stringify([...savedPackKeys].sort()) ||
    JSON.stringify([...itemIds].sort()) !== JSON.stringify([...savedItemIds].sort());

  const selectSkill = (item: PublicSkillItem) => {
    setSelected(item.item_id);
    setSelectedDocument('');
  };
  const selectReadme = (key: string) => {
    setSelected('');
    setSelectedDocument(key);
  };
  const install = async () => {
    if (!current || !props.selectedAgent) return;
    setBusy(true);
    try {
      await publicSkillApi.install(current, props.teamId, props.selectedAgent);
      setInstalledRefresh((value) => value + 1);
      tea.notify.success(`已安装 ${current.name}`);
    } catch (error) {
      tea.notify.error(error);
    } finally {
      setBusy(false);
    }
  };
  const sync = async () => {
    setBusy(true);
    try {
      await publicSkillApi.sync();
      await refresh();
      tea.notify.success('公共 Skill 已同步');
    } catch (error) {
      tea.notify.error(error);
    } finally {
      setBusy(false);
    }
  };
  const installPack = async (packKey: string) => {
    if (!props.selectedAgent) return;
    setBusyPack(packKey);
    try {
      const job = await publicSkillApi.installPack(packKey, props.teamId, props.selectedAgent);
      setPackJob(job);
      if (job.status === 'completed' || job.status === 'empty' || job.status === 'partial') {
        setBusyPack('');
        setInstalledRefresh((value) => value + 1);
      }
    } catch (error) {
      setBusyPack('');
      tea.notify.error(error);
    }
  };
  const retryPack = async () => {
    if (!packJob) return;
    setBusyPack(packJob.selection_key ?? '');
    try {
      setPackJob(await publicSkillApi.retryBootstrap(packJob.job_id));
    } catch (error) {
      setBusyPack('');
      tea.notify.error(error);
    }
  };
  const togglePack = (packKey: string, packItems: PublicSkillItem[]) => {
    if (!props.canManageTeam) return;
    if (packKeys.includes(packKey)) setPackKeys(packKeys.filter((key) => key !== packKey));
    else {
      setPackKeys([...packKeys, packKey]);
      const packItemIds = new Set(packItems.map((item) => item.item_id));
      setItemIds(itemIds.filter((itemId) => !packItemIds.has(itemId)));
    }
  };
  const toggleItem = (itemId: string) => {
    if (!props.canManageTeam) return;
    setItemIds(
      itemIds.includes(itemId) ? itemIds.filter((id) => id !== itemId) : [...itemIds, itemId],
    );
  };
  const savePolicy = async () => {
    setBusy(true);
    try {
      const policy = await publicSkillApi.setPolicy(props.teamId, packKeys, itemIds);
      setPackKeys(policy.pack_keys);
      setItemIds(policy.item_ids);
      setSavedPackKeys(policy.pack_keys);
      setSavedItemIds(policy.item_ids);
      tea.notify.success('Team 默认扩展策略已保存，仅影响后续新建 Agent');
    } catch (error) {
      tea.notify.error(error);
    } finally {
      setBusy(false);
    }
  };

  const statusTheme =
    status.status === 'ready' ? 'success' : status.status === 'partial' ? 'warning' : 'error';
  return (
    <div className="_memory-public-skills-panel">
      <div className="_memory-public-skill-toolbar">
        <Segment
          value={layer}
          onChange={(value) => {
            const next = value as Layer;
            setLayer(next);
            setSelected('');
            setSelectedDocument(next === 'core' ? 'core' : 'extensions');
          }}
          options={[
            { value: 'core', text: '核心基础技能' },
            { value: 'extension', text: '业务扩展技能' },
          ]}
        />
        <Input
          value={query}
          onChange={setQuery}
          placeholder="搜索公共 Skill"
          onPressEnter={() => void refresh()}
        />
        <Button onClick={() => void refresh()}>搜索</Button>
        {props.isSystemAdmin && (
          <Button onClick={() => void sync()} loading={busy}>
            立即同步
          </Button>
        )}
        <Tag theme={statusTheme}>{String(status.status ?? 'disabled')}</Tag>
      </div>

      {layer === 'extension' && props.teamId && (
        <div className="_memory-public-policy">
          <div>
            <strong>Team 默认扩展</strong>
            <span>按扩展包或单个 Skill 选择，仅在后续创建 Agent 时自动安装。</span>
          </div>
          {props.canManageTeam ? (
            <Button
              type="primary"
              disabled={!policyDirty}
              loading={busy}
              onClick={() => void savePolicy()}
            >
              保存默认策略
            </Button>
          ) : (
            <Tag>只读</Tag>
          )}
        </div>
      )}

      {packJob && (
        <div className={`_memory-public-job _memory-public-job--${packJob.status}`}>
          <span>
            <strong>{packJob.selection_key}</strong>：{packJob.succeeded}/{packJob.total} 已安装
          </span>
          {packJob.failed > 0 && <span>{packJob.failed} 项失败</span>}
          {packJob.status === 'partial' && (
            <Button onClick={() => void retryPack()}>仅重试失败项</Button>
          )}
        </div>
      )}

      {loading ? (
        <div className="_memory-public-skill-state">加载中…</div>
      ) : (
        <div className="_memory-public-skill-layout">
          <aside className="_memory-public-catalog">
            <button
              className="_memory-public-readme"
              type="button"
              onClick={() => selectReadme('root')}
            >
              仓库说明
            </button>
            {layer === 'core' ? (
              <>
                <div className="_memory-public-group-head">
                  <span>
                    <strong>Core</strong> <PartitionTag status={partitionStates.get('core')} />
                  </span>
                  <button type="button" onClick={() => selectReadme('core')}>
                    README
                  </button>
                </div>
                {coreItems.length === 0 ? (
                  <div className="_memory-public-empty">暂无核心 Skill</div>
                ) : (
                  coreItems.map((item) => (
                    <SkillRow
                      key={item.item_id}
                      item={item}
                      selected={selected === item.item_id}
                      onSelect={() => selectSkill(item)}
                    />
                  ))
                )}
              </>
            ) : (
              <>
                <button
                  className="_memory-public-readme"
                  type="button"
                  onClick={() => selectReadme('extensions')}
                >
                  扩展层说明
                </button>
                {extensionPacks.length === 0 ? (
                  <div className="_memory-public-empty">暂无扩展 Skill</div>
                ) : (
                  extensionPacks.map(([packKey, packItems]) => {
                    const wholePack = packKeys.includes(packKey);
                    const allLatest = packItems.every(
                      (item) => installed[item.item_id]?.contentHash === item.content_hash,
                    );
                    return (
                      <div className="_memory-public-pack" key={packKey}>
                        <div className="_memory-public-pack-head">
                          <Checkbox
                            value={wholePack}
                            disabled={!props.canManageTeam}
                            onChange={() => togglePack(packKey, packItems)}
                          >
                            <strong>{packKey.toUpperCase()}</strong>{' '}
                            <PartitionTag status={partitionStates.get(`extension:${packKey}`)} />
                          </Checkbox>
                          <div>
                            <Button
                              type="text"
                              onClick={() => selectReadme(`extension:${packKey}`)}
                            >
                              README
                            </Button>
                            <Button
                              disabled={!props.selectedAgent || allLatest || !!busyPack}
                              loading={busyPack === packKey}
                              onClick={() => void installPack(packKey)}
                            >
                              {allLatest ? '已是最新' : '整包安装'}
                            </Button>
                          </div>
                        </div>
                        {packItems.map((item) => (
                          <div className="_memory-public-pack-item" key={item.item_id}>
                            <Checkbox
                              value={wholePack || itemIds.includes(item.item_id)}
                              disabled={!props.canManageTeam || wholePack}
                              onChange={() => toggleItem(item.item_id)}
                            >
                              <span className="_memory-visually-hidden">
                                将 {item.name} 设为默认
                              </span>
                            </Checkbox>
                            <SkillRow
                              item={item}
                              selected={selected === item.item_id}
                              onSelect={() => selectSkill(item)}
                            />
                          </div>
                        ))}
                      </div>
                    );
                  })
                )}
              </>
            )}
          </aside>

          {current ? (
            <PublicSkillDetail
              item={current}
              selectedAgent={props.selectedAgent}
              installed={!!installedCurrent}
              installedContentHash={installedCurrent?.contentHash}
              busy={busy}
              onInstall={() => void install()}
            />
          ) : currentDocument ? (
            <section className="_memory-public-document">
              <header>
                <div>
                  <h3>{currentDocument.title}</h3>
                  <code>
                    {currentDocument.repo_path}@{currentDocument.source_revision}
                  </code>
                </div>
              </header>
              <div className="_memory-public-document-body">
                <MarkdownView>{currentDocument.content}</MarkdownView>
              </div>
            </section>
          ) : (
            <div className="_memory-public-skill-detail _memory-public-empty">
              请选择一个 Skill 或 README
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SkillRow(props: { item: PublicSkillItem; selected: boolean; onSelect(): void }) {
  return (
    <button
      className={`_memory-public-skill-row${props.selected ? ' is-selected' : ''}`}
      type="button"
      onClick={props.onSelect}
    >
      <strong>{props.item.name}</strong>
      <span>{props.item.description}</span>
    </button>
  );
}

function PartitionTag(props: { status?: string }) {
  if (!props.status) return null;
  const theme =
    props.status === 'ready'
      ? 'success'
      : props.status === 'stale'
        ? 'warning'
        : props.status === 'empty'
          ? 'default'
          : 'error';
  return <Tag theme={theme}>{props.status}</Tag>;
}
