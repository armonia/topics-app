import { useEffect, useRef, useState } from 'react';
import { HardDrive } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { worktreesApi } from '../../lib/apiSystem';
import { formatSize } from '../Browser/downloadsModel';
import type { MachineWorktreeLine } from '../../../../shared/worktree-summary';

/**
 * WORKTREES PER MACHINE (change worktree-standard, T12): one line for each
 * machine, this one and its nodes, with how many worktrees it holds, what they
 * weigh, the free space left under its root and how many live outside it. A
 * node reports on its heartbeat; an older build that does not speak the
 * protocol says so instead of a number.
 */
export function WorktreesMachines() {
  const t = useT();
  const [lines, setLines] = useState<MachineWorktreeLine[] | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void worktreesApi.perMachine().then((l) => { if (alive.current) setLines(l); }).catch(() => {});
    return () => { alive.current = false; };
  }, []);

  if (!lines || lines.length === 0) return null;
  return (
    <div className="space-y-1 border-t border-app-border pt-3" data-testid="worktrees-machines">
      <span className="text-compact text-app-text">{t('worktrees.machines')}</span>
      <ul className="space-y-1">
        {lines.map((line) => <MachineLine key={line.machineId} line={line} />)}
      </ul>
    </div>
  );
}

function MachineLine({ line }: { line: MachineWorktreeLine }) {
  const t = useT();
  const s = line.summary;
  const facts = line.supported === false
    ? [t('worktrees.machines.oldNode')]
    : !s
      ? [t('worktrees.machines.notReported')]
      : [
        t('worktrees.count', { n: String(s.count) }),
        s.bytes === null ? null : formatSize(s.bytes),
        s.rootFreeGb === null ? null : t('worktrees.machines.free', { n: String(s.rootFreeGb) }),
        t('worktrees.machines.foreign', { n: String(s.foreign) }),
      ].filter((f): f is string => !!f);
  return (
    <li className="flex min-w-0 items-start gap-2 py-1" data-testid="worktrees-machine-line" data-machine={line.machineId}>
      <HardDrive size={14} className="mt-0.5 flex-shrink-0 text-app-text-muted" />
      <span className="flex min-w-0 flex-col">
        <span className="break-words text-compact text-app-text">
          {line.name}{line.local ? ` · ${t('worktrees.machines.this')}` : ''}{line.status === 'offline' ? ` · ${t('worktrees.machines.offline')}` : ''}
        </span>
        <span className="text-mini break-words text-app-text-muted" title={s?.root}>{facts.join(' · ')}</span>
      </span>
    </li>
  );
}
