import type { SkillFileTreeNode } from './skill-file-tree';
import './skill-file-tree.css';

export function SkillFileTree(props: {
  nodes: SkillFileTreeNode[];
  selectedPath?: string;
  onPick(path: string): void;
}) {
  return (
    <ul className="_memory-skill-filetree">
      {props.nodes.map((node) => (
        <li key={node.fullPath ?? `dir:${node.name}`}>
          {node.fullPath ? (
            <button
              type="button"
              title={node.fullPath}
              onClick={() => props.onPick(node.fullPath!)}
              className={`_memory-skill-file-btn${props.selectedPath === node.fullPath ? ' _memory-skill-file-btn--active' : ''}`}
            >
              {node.name}
            </button>
          ) : (
            <>
              <div className="_memory-skill-dir">{node.name}/</div>
              <SkillFileTree
                nodes={node.children}
                selectedPath={props.selectedPath}
                onPick={props.onPick}
              />
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
