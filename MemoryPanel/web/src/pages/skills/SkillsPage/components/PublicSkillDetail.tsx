import { useEffect, useMemo, useState } from 'react';
import { Button, Text } from 'tea-component';

import { MarkdownView } from '@/components/MarkdownView';
import {
  publicSkillApi,
  type PublicSkillItem,
  type PublicSkillResource,
  type PublicSkillSnapshot,
} from '@/lib/public-skill-api';
import { SkillFileTree } from './SkillFileTree';
import { buildSkillFileTree } from './skill-file-tree';
import {
  decodePublicSkillResource,
  publicSkillPreviewKind,
  splitSkillMarkdown,
} from './public-skill-preview';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function ResourcePreview(props: { resource: PublicSkillResource; sizeBytes: number }) {
  const kind = publicSkillPreviewKind(props.resource.path, props.resource.mime_type);
  const dataUrl = `data:${props.resource.mime_type || 'application/octet-stream'};base64,${props.resource.content}`;
  let decoded = '';
  if (kind === 'markdown' || kind === 'text') {
    try {
      decoded = decodePublicSkillResource(props.resource.content);
    } catch {
      return <Text theme="danger">文件内容解码失败</Text>;
    }
  }

  if (kind === 'markdown') return <MarkdownView>{decoded}</MarkdownView>;
  if (kind === 'text') return <pre className="_memory-skill-file-content">{decoded}</pre>;
  if (kind === 'image') {
    return <img className="_memory-public-skill-image" src={dataUrl} alt={props.resource.path} />;
  }
  return (
    <div className="_memory-public-skill-binary">
      <Text theme="weak" parent="div">
        该文件为二进制资源，无法直接转成文本预览。
      </Text>
      <a
        className="_memory-public-skill-download"
        href={dataUrl}
        download={props.resource.path.split('/').at(-1)}
      >
        下载文件（{formatBytes(props.sizeBytes)}）
      </a>
    </div>
  );
}

export function PublicSkillDetail(props: {
  item: PublicSkillItem;
  selectedAgent: string;
  installed: boolean;
  installedContentHash?: string;
  busy: boolean;
  onInstall(): void;
}) {
  const [snapshot, setSnapshot] = useState<PublicSkillSnapshot | null>(null);
  const [selectedPath, setSelectedPath] = useState('SKILL.md');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSnapshot(null);
    setSelectedPath('SKILL.md');
    setLoading(true);
    setError(null);
    void publicSkillApi
      .get(props.item.item_id, props.item.source_revision)
      .then((value) => {
        if (active) setSnapshot(value);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [props.item.item_id, props.item.source_revision]);

  const tree = useMemo(
    () =>
      buildSkillFileTree(['SKILL.md', ...(snapshot?.manifest.map((entry) => entry.path) ?? [])]),
    [snapshot],
  );
  const selectedResource =
    snapshot?.resources.find((resource) => resource.path === selectedPath) ?? null;
  const selectedManifest = snapshot?.manifest.find((entry) => entry.path === selectedPath) ?? null;
  const skillMarkdown = useMemo(
    () => splitSkillMarkdown(snapshot?.content ?? ''),
    [snapshot?.content],
  );
  const installedLatest = props.installed && props.installedContentHash === props.item.content_hash;

  return (
    <section className="_memory-public-skill-detail">
      <header className="_memory-public-skill-detail-head">
        <div>
          <h3>{props.item.name}</h3>
          <p>{props.item.description}</p>
          <div className="_memory-public-skill-source">
            来源：
            <code>
              {props.item.repo_path}@{props.item.source_revision}
            </code>
            <span>{props.item.manifest.length + 1} 个文件</span>
            <span>{formatBytes(props.item.total_bytes)} 附属资源</span>
          </div>
        </div>
        <Button
          type="primary"
          disabled={!props.selectedAgent || installedLatest}
          loading={props.busy}
          onClick={props.onInstall}
        >
          {!props.installed ? '安装到 Agent' : installedLatest ? '已是最新' : '升级'}
        </Button>
      </header>

      {loading ? <div className="_memory-public-skill-state">正在读取完整 Skill…</div> : null}
      {error ? (
        <div className="_memory-public-skill-state _memory-public-skill-state--error">{error}</div>
      ) : null}
      {snapshot ? (
        <div className="_memory-public-skill-browser">
          <aside className="_memory-public-skill-tree">
            <div className="_memory-public-skill-pane-title">文件</div>
            <SkillFileTree nodes={tree} selectedPath={selectedPath} onPick={setSelectedPath} />
          </aside>
          <article className="_memory-public-skill-preview">
            <div className="_memory-public-skill-preview-head">
              <code>{selectedPath}</code>
              {selectedManifest ? (
                <span>
                  {selectedManifest.mime_type} · {formatBytes(selectedManifest.size_bytes)}
                  {selectedManifest.is_executable ? ' · executable' : ''}
                </span>
              ) : (
                <span>主入口</span>
              )}
            </div>
            <div className="_memory-public-skill-preview-body">
              {selectedPath === 'SKILL.md' ? (
                <>
                  <div className="_memory-public-skill-section-title">Frontmatter</div>
                  <pre className="_memory-skill-detail-json">
                    {skillMarkdown.frontmatter || '无 frontmatter'}
                  </pre>
                  <div className="_memory-public-skill-section-title">正文</div>
                  <MarkdownView>{skillMarkdown.body}</MarkdownView>
                </>
              ) : selectedResource && selectedManifest ? (
                <ResourcePreview
                  resource={selectedResource}
                  sizeBytes={selectedManifest.size_bytes}
                />
              ) : (
                <Text theme="weak">文件不存在于当前快照</Text>
              )}
            </div>
          </article>
        </div>
      ) : null}
    </section>
  );
}
