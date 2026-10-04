import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { formatDurationMs } from './toolGrouping';
import { formatTimeLeft, sleepLeftMs } from './silentShell';

/**
 * A running command that has printed nothing yet says so, with how long it has
 * been running and, when it opens with `sleep N`, how much of the wait is left
 * (CHAT-TOOL-13). Hidden for the first second, like `ElapsedTimer`: an instant
 * command must not blink a status in and out.
 */
export function SilentShellStatus({ since, command }: { since: number; command: string }) {
  const tr = useT();
  // Elapsed lives in state and is advanced by the interval: render stays pure.
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const update = () => setMs(Date.now() - since);
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [since]);
  if (ms < 900) return null;
  const left = sleepLeftMs(command, ms);
  return (
    <div data-testid="shell-silent-status" className="mt-1 text-mini text-app-text-muted tabular-nums">
      {tr('tool.shell.silent', { elapsed: formatDurationMs(ms) })}
      {left !== undefined && (
        <span data-testid="shell-sleep-countdown">{tr('tool.shell.sleepLeft', { left: formatTimeLeft(left) })}</span>
      )}
    </div>
  );
}
