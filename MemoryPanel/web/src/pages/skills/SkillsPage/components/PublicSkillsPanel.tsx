import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Select, Tag } from 'tea-component';
import { publicSkillApi, type PublicSkillItem } from '@/lib/public-skill-api';
import { tea } from '@/lib/tea-bridge';
import { listSkills } from '@/lib/skill-api';

export function PublicSkillsPanel(props: {
  teamId: string;
  agents: Array<{ id: string; name: string }>;
  selectedAgent: string;
  onAgentChange(value: string): void;
  isSystemAdmin: boolean;
}) {
  const [items, setItems] = useState<PublicSkillItem[]>([]);
  const [status, setStatus] = useState<Record<string, unknown>>({});
  const [selected, setSelected] = useState<string>('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [installed, setInstalled] = useState<Record<string, { contentHash: string; version: number }>>({});
  const load = useCallback(async (queryValue: string) => {
    setLoading(true);
    try { const [list, source] = await Promise.all([publicSkillApi.list(queryValue), publicSkillApi.status()]); setItems(list.items); setStatus(source); }
    catch (error) { tea.notify.error(error); } finally { setLoading(false); }
  }, []);
  const refresh = () => load(query);
  useEffect(() => { void load(''); }, [load]);
  useEffect(() => {
    if (!props.teamId || !props.selectedAgent) { setInstalled({}); return; }
    void listSkills({ team_id: props.teamId, filters: { owner_agent_id: props.selectedAgent, status: ['active'] }, pagination: { limit: 1000 } })
      .then((result) => {
        const next: Record<string, { contentHash: string; version: number }> = {};
        for (const skill of result.items) {
          const origin = skill.metadata?.catalog_origin as { item_id?: string; content_hash?: string } | undefined;
          if (origin?.item_id) next[origin.item_id] = { contentHash: origin.content_hash ?? '', version: skill.version };
        }
        setInstalled(next);
      }).catch(() => setInstalled({}));
  }, [props.teamId, props.selectedAgent, busy]);
  const current = useMemo(() => items.find((item) => item.item_id === selected) ?? null, [items, selected]);
  const installedCurrent = current ? installed[current.item_id] : undefined;

  const install = async () => {
    if (!current || !props.selectedAgent) return;
    setBusy(true);
    try { await publicSkillApi.install(current, props.teamId, props.selectedAgent); tea.notify.success(`已安装 ${current.name}`); }
    catch (error) { tea.notify.error(error); } finally { setBusy(false); }
  };
  const sync = async () => { setBusy(true); try { await publicSkillApi.sync(); await refresh(); tea.notify.success('公共 Skill 已同步'); } catch (error) { tea.notify.error(error); } finally { setBusy(false); } };

  return <div style={{ padding: 20 }}>
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 }}>
      <Input value={query} onChange={setQuery} placeholder="搜索公共 Skill" onPressEnter={() => void refresh()} />
      <Select appearance="button" value={props.selectedAgent} onChange={props.onAgentChange}
        placeholder="选择目标 Agent" options={props.agents.map((a) => ({ value: a.id, text: a.name }))} />
      <Button onClick={() => void refresh()}>搜索</Button>
      {props.isSystemAdmin && <Button onClick={() => void sync()} loading={busy}>立即同步</Button>}
      <Tag theme={status.status === 'ready' ? 'success' : 'warning'}>{String(status.status ?? 'disabled')}</Tag>
      {status.active_commit ? <code>{String(status.active_commit)}</code> : null}
    </div>
    {loading ? <div style={{ padding: 24 }}>加载中…</div> : <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16 }}>
      <div style={{ border: '1px solid #ddd', maxHeight: 600, overflow: 'auto' }}>
        {items.length === 0 ? <div style={{ padding: 20 }}>仓库尚无已发布 Skill</div> : items.map((item) =>
          <button key={item.item_id} type="button" onClick={() => setSelected(item.item_id)} style={{ display: 'block', width: '100%', padding: 12, textAlign: 'left', border: 0, borderBottom: '1px solid #eee', background: selected === item.item_id ? '#eef5ff' : '#fff' }}>
            <strong>{item.name}</strong><div style={{ color: '#666', marginTop: 4 }}>{item.description}</div>
          </button>)}
      </div>
      <div style={{ border: '1px solid #ddd', padding: 20 }}>
        {!current ? '请选择一个公共 Skill' : <>
          <h3>{current.name}</h3><p>{current.description}</p>
          <p>来源：<code>{current.repo_path}@{current.source_revision}</code></p>
          <p>资源：{current.manifest.length} 个，{current.total_bytes} bytes</p>
          <ul>{current.manifest.map((file) => <li key={file.path}><code>{file.path}</code></li>)}</ul>
          <Button type="primary" disabled={!props.selectedAgent || installedCurrent?.contentHash === current.content_hash} loading={busy} onClick={() => void install()}>
            {!installedCurrent ? '安装到 Agent' : installedCurrent.contentHash === current.content_hash ? '已是最新' : '升级'}
          </Button>
        </>}
      </div>
    </div>}
  </div>;
}
