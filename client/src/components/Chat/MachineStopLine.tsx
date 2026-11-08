import { CircleStop } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { backgroundNoticeSentence, type BackgroundNoticeBlock, type MachineStopCause } from './machineRow';

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
 * card's drawer, so the same row reads the same on both surfaces. A stop that
 * also closed the chat's background work carries that notice in the same row,
 * and says both on the same line.
 */
export function MachineStopLine({ cause, closed }: { cause: MachineStopCause; closed?: BackgroundNoticeBlock | null }) {
  const tr = useT();
  const sentence = closed ? `${tr(MACHINE_STOP_KEY[cause])}. ${backgroundNoticeSentence(tr, closed)}` : tr(MACHINE_STOP_KEY[cause]);
  return (
    <div
      data-testid="machine-stop-row"
      data-cause={cause}
      className="my-1 flex items-center justify-center gap-1.5 px-2 text-mini text-app-text-muted"
    >
      <CircleStop size={11} className="flex-shrink-0" aria-hidden="true" />
      {/* With the closed work it is two sentences: wrapped, as the notice's own line. */}
      <span className={closed ? 'min-w-0 text-center' : 'truncate'} title={closed?.event === 'closed' ? closed.tasks.join('\n') : undefined}>{sentence}</span>
    </div>
  );
}
