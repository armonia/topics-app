import { useState } from 'react';
import { WrapText, Eye, Code, Copy, Check } from 'lucide-react';
import { copyText } from '../../lib/clipboard';
import { useT } from '../../hooks/useT';

/** Small icon buttons shared by the editor toolbars (tab strip and single-file pane). */

export function CopyPathBtn({ filePath, projectPath }: { filePath: string; projectPath: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copyPath = async () => {
    const rel = filePath.replace(projectPath, '').replace(/^\//, '');
    if (!(await copyText(rel))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button onClick={copyPath} title={t('editor.toolbar.copyPath')} className="p-0.5 rounded hover:bg-app-hover transition-colors text-app-text-muted">
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

export function WrapBtn({ active, onClick }: { active: boolean; onClick: () => void }) {
  const t = useT();
  return (
    // `aria-pressed`, not just the tint: on and off used to differ only by icon
    // colour, which a screen reader (or a spec) cannot read.
    <button onClick={onClick} title={t('editor.toolbar.wrap')} aria-pressed={active} data-testid="editor-wrap-toggle" className={`p-0.5 rounded hover:bg-app-hover transition-colors ${active ? 'text-primary' : 'text-app-text-muted'}`}>
      <WrapText size={13} />
    </button>
  );
}

export function PreviewBtn({ previewing, onClick, label = 'Markdown' }: { previewing: boolean; onClick: () => void; label?: string }) {
  const t = useT();
  return (
    <button onClick={onClick} title={previewing ? t('editor.toolbar.showSource') : t('editor.toolbar.preview', { label })} className={`p-0.5 rounded hover:bg-app-hover transition-colors ${previewing ? 'text-primary' : 'text-app-text-muted'}`}>
      {previewing ? <Code size={13} /> : <Eye size={13} />}
    </button>
  );
}
