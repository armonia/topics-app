import { Fragment } from 'react';
import { ChevronRight, MessagesSquare } from 'lucide-react';
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
export function ChannelChipView({ chip, notify, open = openTabInApp, full = false }: {
  chip: ChannelChip;
  /** Told when the chat no longer exists, so the click is never silent. */
  notify?: (message: string) => void;
  /** The in-app door; injectable so a test needs no module mock. */
  open?: typeof openTabInApp;
  /** The drawer shows the whole path; a card truncates its middle piece. */
  full?: boolean;
}) {
  const Mark = CHANNEL_MARKS[MARK_KEY[chip.kind]]!;
  const head = chip.segments.filter((seg) => seg.level !== 'thread');
  const thread = chip.segments.find((seg) => seg.level === 'thread');
  return (
    <button
      type="button"
      data-testid="card-channel"
      data-channel-kind={chip.kind}
      title={chip.title}
      aria-label={chip.title}
      className={`flex min-w-0 max-w-full flex-wrap items-center gap-x-1 gap-y-0.5 overflow-hidden rounded px-1.5 py-0.5 text-left text-compact leading-4 transition-colors md:text-mini ${TONE[chip.kind]}`}
      onClick={(e) => { e.stopPropagation(); open({ kind: 'chat', key: chip.topicId }, { notify }); }}
    >
      {/* Row one: mark, server (never cut), channel (cuts first). The thread drops to row two when the path does not fit. */}
      <span data-testid="card-channel-head" className="flex min-w-0 max-w-full items-center gap-1">
        <Mark className="h-3 w-3 shrink-0" aria-hidden />
        {head.map((seg, i) => {
          const last = i === head.length - 1;
          const shrink = full ? '' : seg.level === 'server' ? 'shrink-0 whitespace-nowrap' : last ? 'min-w-0 shrink truncate' : 'min-w-12 shrink truncate';
          return (
            <Fragment key={i}>
              {i > 0 && <ChevronRight className="h-3 w-3 shrink-0 opacity-60" aria-hidden />}
              <span data-testid={`card-channel-${seg.level}`} className={shrink}>{seg.text}</span>
            </Fragment>
          );
        })}
      </span>
      {thread && (
        <span data-testid="card-channel-thread-row" className="flex min-w-0 max-w-full items-center gap-1">
          <MessagesSquare className="h-3 w-3 shrink-0" aria-label="thread" />
          <span data-testid="card-channel-thread" className={full ? '' : 'block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap'}>{thread.text}</span>
        </span>
      )}
    </button>
  );
}
