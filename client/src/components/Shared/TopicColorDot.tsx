import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import { topicColorInks } from '@/lib/topicColor';

/**
 * The colour a person chose for a topic, as a small SWATCH: the same mark on
 * the sidebar row, on its pinned tile, on the tab and on the phone's title
 * bar, so they read as one thing. On the row it sits where the row already
 * has room (see `TopicItem`), never in a column that would move the name.
 *
 * A SQUARE, not a circle, and that shape is load-bearing (card 300620c0,
 * reflection of 2026-11-16): every round "pallino" elsewhere in the sidebar
 * (`STATUS_DOT`, the attention fill, the inbox's busy dot) is a STATE, lit
 * only while it is true and gone the moment it is not. This one is a person's
 * stored choice, painted every time regardless of what the chat is doing, and
 * on a round footprint it kept reading as one more status light — reported
 * on a chat coloured green ("needs something"), on one mid-turn ("there's a
 * dot but it's working"), on one with nothing left to say ("there should be
 * no dot"). A colour never says state (see `topicColorInks`); now its shape
 * says so too, at a glance, before anyone has to remember the rule.
 *
 * Nothing renders for a default colour (see `topicColorInks`): the swatch
 * exists only where there was a choice, and clearing the colour takes it
 * away. It is decoration, `aria-hidden`: the name next to it is what
 * identifies the topic.
 *
 * The ring: an ink that clears 3:1 against the chrome on its own keeps the
 * faint neutral ring; one that does not (yellow on light, a pale free pick)
 * gets the computed ring of `topicColorInks` (`ringLight` / `ringDark`), which
 * does. On an attention fill (blue/amber row) the ring turns white so the
 * swatch does not melt into the fill.
 */
export function TopicColorDot({ color, onFill, className }: { color: string | null | undefined; onFill?: boolean; className?: string }) {
  const inks = topicColorInks(color);
  if (!inks) return null;
  const ringClass = onFill
    ? 'ring-white/70'
    : cn(
        inks.ringLight ? 'ring-[color:var(--topic-ring)]' : 'ring-black/10',
        inks.ringDark ? 'dark:ring-[color:var(--topic-ring-dark)]' : 'dark:ring-white/15',
      );
  const style: Record<string, string> = { '--topic-ink': inks.light, '--topic-ink-dark': inks.dark };
  if (inks.ringLight) style['--topic-ring'] = inks.ringLight;
  if (inks.ringDark) style['--topic-ring-dark'] = inks.ringDark;
  return (
    <span
      aria-hidden="true"
      data-topic-color={inks.value}
      className={cn(
        // `rounded-[2px]`, not `rounded-full`: see the module doc. A square
        // reads as a swatch; a circle, on this row, reads as a status light.
        'shrink-0 w-2 h-2 rounded-[2px] bg-[var(--topic-ink)] dark:bg-[var(--topic-ink-dark)] ring-1',
        ringClass,
        className,
      )}
      style={style as CSSProperties}
    />
  );
}
