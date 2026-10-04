/**
 * THE SIGN OF A SERVER THE CHAT KEEPS UP, on its sidebar row.
 *
 * A process meant to stay up (a dev server the agent started with
 * `run_script`, or with `run_command` and no wake) is not work in progress:
 * nothing will come back from it, and the chat is free. Since 2026-10-04 a job
 * the chat waits for reads as in progress like a turn, so the server is the one
 * state left apart: this sign, which neither turns the ring nor lights anything.
 * The servers come from the poll's `services` (BGVIS-08, `runningServices.ts`);
 * one that just ended is left out, its end is said in the chat.
 */
import { Server } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useT } from '@/hooks/useT';
import { ON_FILL_TEXT_SOFT } from '@/lib/selectionStyles';
import { listenLabel, type RunningServiceSummary } from '../../../../shared/background-work';

export function ServerSign({ services, onFill }: { services: readonly RunningServiceSummary[] | undefined; onFill: boolean }) {
  const tr = useT();
  const running = (services ?? []).filter((s) => !s.ended);
  if (running.length === 0) return null;
  const where = running.map((s) => (s.listen[0] ? listenLabel(s.listen[0]) : s.description)).join(', ');
  const title = tr('topic.serverOn', { where });
  return (
    <span
      className={cn('flex-shrink-0 flex items-center', onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-tertiary')}
      title={title}
      aria-label={title}
      data-testid="row-server-sign"
      data-count={running.length}
    >
      <Server size={12} />
    </span>
  );
}
