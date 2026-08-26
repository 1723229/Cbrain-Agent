import { describe, expect, it } from 'vitest';

import { buildSkillFileTree } from '../web/src/pages/skills/SkillsPage/components/skill-file-tree.js';
import {
  decodePublicSkillResource,
  publicSkillPreviewKind,
  splitSkillMarkdown,
} from '../web/src/pages/skills/SkillsPage/components/public-skill-preview.js';

describe('public Skill preview helpers', () => {
  it('builds a stable nested tree that includes SKILL.md and every resource', () => {
    expect(buildSkillFileTree([
      'references/deep/checklist.md',
      'SKILL.md',
      'assets/logo.png',
      'scripts/verify.sh',
      'references/overview.md',
    ])).toEqual([
      {
        name: 'assets', fullPath: null, children: [
          { name: 'logo.png', fullPath: 'assets/logo.png', children: [] },
        ],
      },
      {
        name: 'references', fullPath: null, children: [
          {
            name: 'deep', fullPath: null, children: [
              { name: 'checklist.md', fullPath: 'references/deep/checklist.md', children: [] },
            ],
          },
          { name: 'overview.md', fullPath: 'references/overview.md', children: [] },
        ],
      },
      {
        name: 'scripts', fullPath: null, children: [
          { name: 'verify.sh', fullPath: 'scripts/verify.sh', children: [] },
        ],
      },
      { name: 'SKILL.md', fullPath: 'SKILL.md', children: [] },
    ]);
  });

  it('splits SKILL.md without losing frontmatter or body content', () => {
    const result = splitSkillMarkdown('---\nname: demo\ndescription: Demo\n---\n\n# 标题\n\n正文');
    expect(result.frontmatter).toBe('name: demo\ndescription: Demo');
    expect(result.body).toBe('# 标题\n\n正文');
  });

  it('decodes UTF-8 resources and classifies common preview types', () => {
    const content = '中文清单';
    const encoded = Buffer.from(content, 'utf8').toString('base64');
    expect(decodePublicSkillResource(encoded)).toBe(content);
    expect(publicSkillPreviewKind('references/checklist.md', 'text/markdown')).toBe('markdown');
    expect(publicSkillPreviewKind('scripts/check.sh', 'text/x-shellscript')).toBe('text');
    expect(publicSkillPreviewKind('assets/logo.png', 'image/png')).toBe('image');
    expect(publicSkillPreviewKind('assets/archive.zip', 'application/zip')).toBe('binary');
  });
});
