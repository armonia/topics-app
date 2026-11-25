import type { MouseEvent, ReactNode } from 'react';
import { ArrowRight, Bot, Eye, Link, Sparkles, Split, User, Zap } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Chip } from '../primitives/Chip';
import type { ActorModel } from './model';

/** The chip that says who does a step, in the colour of its kind. */
export function ActorChip({ actor, copy }: { actor: ActorModel; copy: UiCopy }) {
  switch (actor.kind) {
    case 'trigger': return <Chip icon={Zap} strong>{copy.flows.trigger}</Chip>;
    case 'rule': return <Chip tone="blue" icon={Split} strong>{copy.flows.rule}</Chip>;
    /* A named agent (the ORBIT edition) is the robot with its name; otherwise the product's AI chip. */
    case 'ai': return actor.name ? <Chip tone="pink" icon={Bot} strong>{actor.name}</Chip> : <Chip tone="pink" icon={Sparkles} strong>{copy.common.ai}</Chip>;
    case 'person': return <Chip tone="amber" icon={User} strong>{copy.flows.person}</Chip>;
    case 'program': return <Chip tone={actor.tone ?? 'green'} icon={Link} strong>{actor.name}</Chip>;
    case 'action': return <Chip icon={ArrowRight} strong>{actor.name ?? copy.flowBuild.actionActor}</Chip>;
  }
}

/**
 * The view a step opens, as a quiet chip: the step does not end in a message.
 * `link` draws it in the link colour, once the step can really be followed.
 */
export function OpensChip({ target, copy, link, onOpen, wrap }: { target: string; copy: UiCopy; link?: boolean; onOpen?: () => void; /** Inside a narrow card: the label wraps between words instead of leaving the card. */ wrap?: boolean }) {
  const Tag = onOpen ? 'button' : 'span';
  return (
    <Tag
      type={onOpen ? 'button' : undefined}
      onClick={onOpen ? (e: MouseEvent) => { e.stopPropagation(); onOpen(); } : undefined}
      className={clsx(
        'inline-flex items-center gap-1 rounded-full bg-black/[0.05] px-2 text-mini dark:bg-white/10',
        wrap ? 'min-h-5 max-w-full py-0.5 text-left leading-4 [overflow-wrap:break-word]' : 'h-5 shrink-0 whitespace-nowrap',
        link ? 'text-primary hover:underline dark:text-primary-dark' : 'text-app-text-secondary',
        onOpen && 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
      )}
    >
      <Eye size={12} aria-hidden="true" className="shrink-0" />
      {wrap ? <span className="min-w-0">{copy.common.opens(target)}</span> : copy.common.opens(target)}
    </Tag>
  );
}

/** A circle on the timeline: a number, a letter, or a glyph for the trigger. */
export function StepMarker({ children, size = 24 }: { children: ReactNode; size?: number }) {
  return (
    <span
      style={{ width: size, height: size }}
      className="relative z-10 inline-flex shrink-0 items-center justify-center rounded-full border border-app-border-light bg-surface text-mini font-medium tabular-nums text-app-text-secondary"
    >
      {children}
    </span>
  );
}
