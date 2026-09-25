import { CircleStop } from 'lucide-react';
import { useT } from '../../hooks/useT';
import type { MachineStopCause } from './machineRow';

/** The sentence for each cause, by key: an explicit map, so a cause without
 *  its sentence does not compile. */
const MACHINE_STOP_KEY = {
  'superseded': 'chat.machineStop.superseded',
  'wall-clock': 'chat.machineStop.wallClock',
  'stall': 'chat.machineStop.stall',
} as const;

/**
 * The one neutral line under a turn the machine stopped before it said
 * anything (server/lib/machine-stop-notice.ts). Shared by the chat and the
 * card's drawer, so the same row reads the same on both surfaces.
 */
export function MachineStopLine({ cause }: { cause: MachineStopCause }) {
  const tr = useT();
  return (
    <div
      data-testid="machine-stop-row"
      data-cause={cause}
      className="my-1 flex items-center justify-center gap-1.5 px-2 text-mini text-app-text-muted"
    >
      <CircleStop size={11} className="flex-shrink-0" aria-hidden="true" />
      <span className="truncate">{tr(MACHINE_STOP_KEY[cause])}</span>
    </div>
  );
}
