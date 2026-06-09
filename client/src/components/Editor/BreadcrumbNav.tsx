import { useState, useEffect, useRef, Fragment } from 'react';
import { ChevronRight, Folder } from 'lucide-react';
import { filesApi } from '../../lib/api';
import { getFileIconDef } from '../../lib/fileIcons';
import { DropdownPortal } from '../Shared/DropdownPortal';
import type { FileNode } from '../../types';

function BreadcrumbSegment({ segment, parentDir, currentChild, isLast, isOpen, onToggle, openFile }: {
  segment: string;
  parentDir: string;
  currentChild: string;
  isLast?: boolean;
  isOpen: boolean;
  onToggle: () => void;
  openFile: (path: string, name: string) => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  // Cache the listing together with the dir it was fetched for, so a directory
  // change invalidates it during render (no clearing effect / setState-in-effect).
  const [cache, setCache] = useState<{ dir: string; nodes: FileNode[] } | null>(null);
  const items = cache && cache.dir === parentDir ? cache.nodes : null;

  useEffect(() => {
    if (!isOpen) return;
    if (items) return;
    filesApi.list(parentDir, 1)
      .then(nodes => setCache({ dir: parentDir, nodes }))
      .catch(() => setCache({ dir: parentDir, nodes: [] }));
  }, [isOpen, parentDir, items]);

  const sorted = items
    ? [...items].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
    : null;

  return (
    <>
      <button
        ref={btnRef}
        onClick={onToggle}
        className={`text-[11px] hover:text-primary hover:underline transition-colors flex-shrink-0 ${
          isLast ? 'text-app-text-secondary' : 'text-app-text-muted'
        }`}
      >
        {segment}
      </button>
      <DropdownPortal open={isOpen} anchorRef={btnRef} onClose={onToggle} align="left">
        <div className="max-h-[300px] overflow-y-auto">
          {!sorted ? (
            <div className="px-3 py-2 text-[11px] text-app-text-muted">Loading…</div>
          ) : sorted.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-app-text-muted">Empty</div>
          ) : sorted.map(node => {
            const isCurrentChild = node.name === currentChild;
            const iconDef = node.type === 'dir' ? null : getFileIconDef(node.name);
            return (
              <button
                key={node.path}
                onClick={() => {
                  if (node.type === 'file') {
                    openFile(node.path, node.name);
                  } else {
                    window.dispatchEvent(new CustomEvent('navigate-explorer', { detail: { path: node.path } }));
                  }
                  onToggle();
                }}
                className={`flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-left hover:bg-app-hover transition-colors ${
                  isCurrentChild ? 'text-primary font-medium' : 'text-app-text-secondary'
                }`}
              >
                {node.type === 'dir'
                  ? <Folder size={14} className="flex-shrink-0 text-app-text-muted" />
                  : <span className="flex-shrink-0">{(() => { const I = iconDef!.icon; return <I size={14} style={{ color: iconDef!.color }} />; })()}</span>
                }
                <span className="truncate">{node.name}</span>
              </button>
            );
          })}
        </div>
      </DropdownPortal>
    </>
  );
}

interface BreadcrumbNavProps {
  filePath: string;
  projectPath: string;
  openFile: (path: string, name: string) => void;
  actions?: React.ReactNode;
}

export function BreadcrumbNav({ filePath, projectPath, openFile, actions }: BreadcrumbNavProps) {
  const [openSegmentIndex, setOpenSegmentIndex] = useState<number | null>(null);
  const relativePath = filePath.replace(projectPath, '').replace(/^\//, '');
  const segments = relativePath.split('/');

  return (
    <div data-testid="breadcrumb-nav" className="flex items-center px-3 py-1 border-b border-app-border bg-elevated dark:bg-app-panel flex-shrink-0 overflow-hidden">
      {segments.map((seg, i) => {
        const parentDir = i === 0 ? projectPath : projectPath + '/' + segments.slice(0, i).join('/');
        const isLast = i === segments.length - 1;
        return (
          <Fragment key={i}>
            {i > 0 && <ChevronRight size={10} className="text-app-text-faint mx-0.5 flex-shrink-0" />}
            <BreadcrumbSegment
              segment={seg}
              parentDir={parentDir}
              currentChild={seg}
              isLast={isLast}
              isOpen={openSegmentIndex === i}
              onToggle={() => setOpenSegmentIndex(prev => prev === i ? null : i)}
              openFile={openFile}
            />
          </Fragment>
        );
      })}

      {actions && (
        <div className="ml-auto flex items-center gap-1 flex-shrink-0">
          {actions}
        </div>
      )}
    </div>
  );
}
