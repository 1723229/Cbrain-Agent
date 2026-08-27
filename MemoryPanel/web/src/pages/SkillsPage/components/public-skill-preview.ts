export type PublicSkillPreviewKind = 'markdown' | 'text' | 'image' | 'binary';

const TEXT_EXTENSIONS = new Set([
  'css',
  'csv',
  'html',
  'ini',
  'java',
  'js',
  'json',
  'jsx',
  'log',
  'properties',
  'py',
  'sh',
  'sql',
  'svg',
  'toml',
  'ts',
  'tsx',
  'txt',
  'xml',
  'yaml',
  'yml',
]);

export function splitSkillMarkdown(content: string): { frontmatter: string; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/);
  if (!match) return { frontmatter: '', body: content };
  return { frontmatter: match[1], body: content.slice(match[0].length).replace(/^\r?\n/, '') };
}

export function decodePublicSkillResource(content: string): string {
  const binary = atob(content);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export function publicSkillPreviewKind(path: string, mimeType: string): PublicSkillPreviewKind {
  const normalizedMime = mimeType.toLowerCase();
  const extension = path.split('.').at(-1)?.toLowerCase() ?? '';
  if (normalizedMime === 'text/markdown' || extension === 'md' || extension === 'markdown')
    return 'markdown';
  if (normalizedMime.startsWith('image/') && normalizedMime !== 'image/svg+xml') return 'image';
  if (
    normalizedMime.startsWith('text/') ||
    normalizedMime.includes('json') ||
    normalizedMime.includes('javascript') ||
    normalizedMime.includes('xml') ||
    normalizedMime.includes('yaml') ||
    TEXT_EXTENSIONS.has(extension)
  )
    return 'text';
  return 'binary';
}
