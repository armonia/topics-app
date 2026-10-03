import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import { topicColorInks } from '@/lib/topicColor';

/**
 * The colour a person chose for a topic, as a small dot: the same mark on the
 * sidebar row and on the tab, so the two read as one thing. On the row it sits
 * where the row already has room (see `TopicItem`), never in a column that
 * would move the name.
 *
 * Nothing renders for a default colour (see `topicColorInks`): the dot exists
 * only where there was a choice, and clearing the colour takes it away. It is
 * decoration, `aria-hidden`: the name next to it is what identifies the topic,
 * and no state is ever said by the colour alone.
 *
 * The ring keeps a light ink visible on a light surface and a dark one on a
 * dark surface; on an attention fill (blue/amber row) it turns white so the
 * dot does not melt into the fill.
 */
export function TopicColorDot({ color, onFill, className }: { color: string | null | undefined; onFill?: boolean; className?: string }) {
  const inks = topicColorInks(color);
  if (!inks) return null;
  return (
    <span
      aria-hidden="true"
      data-topic-color={inks.value}
      className={cn(
        'shrink-0 w-2 h-2 rounded-full bg-[var(--topic-ink)] dark:bg-[var(--topic-ink-dark)] ring-1',
        onFill ? 'ring-white/70' : 'ring-black/10 dark:ring-white/15',
        className,
      )}
      style={{ '--topic-ink': inks.light, '--topic-ink-dark': inks.dark } as CSSProperties}
    />
  );
}
