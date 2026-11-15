import { CHANNEL_MARKS } from '../../lib/brandIcons';
import { openTabInApp } from '../../lib/tabLink';
import type { ChannelChip } from './channelChip';

const TONE: Record<ChannelChip['kind'], string> = {
  discord: 'bg-indigo-500/15 text-indigo-800 hover:bg-indigo-500/25 dark:text-indigo-300',
  whatsapp: 'bg-emerald-500/15 text-emerald-800 hover:bg-emerald-500/25 dark:text-emerald-300',
  telegram: 'bg-sky-500/15 text-sky-800 hover:bg-sky-500/25 dark:text-sky-300',
};
const MARK_KEY: Record<ChannelChip['kind'], string> = { discord: 'Discord', whatsapp: 'WhatsApp', telegram: 'Telegram' };

/**
 * The channel a card's work came from: its official mark and its name, one
 * click from its chat (Jarvis, the agent, is the avatar chip beside it). The click goes through
 * the single in-app door (`openTabInApp`), which checks the chat still exists,
 * so it is never a bare anchor. The name is what truncates on a narrow card.
 */
export function ChannelChipView({ chip, notify, open = openTabInApp }: {
  chip: ChannelChip;
  /** Told when the chat no longer exists, so the click is never silent. */
  notify?: (message: string) => void;
  /** The in-app door; injectable so a test needs no module mock. */
  open?: typeof openTabInApp;
}) {
  const Mark = CHANNEL_MARKS[MARK_KEY[chip.kind]]!;
  return (
    <button
      type="button"
      data-testid="card-channel"
      data-channel-kind={chip.kind}
      title={chip.title}
      aria-label={chip.title}
      className={`flex min-w-0 max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-compact leading-4 transition-colors md:text-mini ${TONE[chip.kind]}`}
      onClick={(e) => { e.stopPropagation(); open({ kind: 'chat', key: chip.topicId }, { notify }); }}
    >
      <Mark className="h-3 w-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{chip.name}</span>
    </button>
  );
}
