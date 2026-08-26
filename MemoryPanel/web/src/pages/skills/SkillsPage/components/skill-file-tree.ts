export interface SkillFileTreeNode {
  name: string;
  fullPath: string | null;
  children: SkillFileTreeNode[];
}

/** Build a deterministic directory-first tree from repository-relative file paths. */
export function buildSkillFileTree(paths: string[]): SkillFileTreeNode[] {
  const root: SkillFileTreeNode = { name: '', fullPath: null, children: [] };
  for (const path of [...new Set(paths.filter(Boolean))]) {
    const parts = path.split('/').filter(Boolean);
    let cursor = root;
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      const isFile = index === parts.length - 1;
      let child = cursor.children.find((node) => node.name === name);
      if (!child) {
        child = { name, fullPath: isFile ? path : null, children: [] };
        cursor.children.push(child);
      }
      cursor = child;
    }
  }

  const sort = (node: SkillFileTreeNode): void => {
    node.children.sort((left, right) => {
      const leftDirectory = left.fullPath === null;
      const rightDirectory = right.fullPath === null;
      if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    node.children.forEach(sort);
  };
  sort(root);
  return root.children;
}
