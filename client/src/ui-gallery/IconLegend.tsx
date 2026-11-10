/**
 * The gallery page `z01` (`ui.html#z01`): the legend of the icon system of
 * the UI layer, grouped like the mockup (`png/z01.png`). Every glyph is read
 * from where the layer takes it (`ui/icons.ts`, `primitives/notice.ts`, the
 * actor chips of `flows/FlowStep.tsx`), so the legend changes when the layer
 * does; the meanings are in `copy.kit.legend`.
 */
import type { ReactNode } from 'react';
import {
  Check, ChevronDown, ChevronLeft, ChevronRight, CornerDownLeft, Download, Link, Lock, Maximize2, Quote, Search, Sparkles,
  Split, User, X, Zap, ZoomIn, ZoomOut, type LucideIcon,
} from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../ui/copy/types';
import type { BlockKind, ControlGlyph, LegendGroup } from '../ui/copy/kit';
import type { FieldKind, NavKind, UiTabKind, Tone } from '../ui/types';
import { FIELD_ICON, FIELD_TONE, NAV_ICON, TAB_ICON } from '../ui/icons';
import { TONE_CHIP, TONE_TEXT } from '../ui/tone';
import { NOTICE_ICON, type NoticeTone } from '../ui/primitives/notice';
import { Spinner } from '../ui/primitives/Progress';
import { AppFrame } from '../ui/shell/AppFrame';
import { PaneHeader } from '../ui/shell/PaneHeader';

/** The actor chips of a flow step (`ActorChip` in `flows/FlowStep.tsx`): glyph and tone. */
const BLOCK: Record<BlockKind, { icon: LucideIcon; tone: Tone }> = {
  trigger: { icon: Zap, tone: 'neutral' },
  rule: { icon: Split, tone: 'blue' },
  ai: { icon: Sparkles, tone: 'pink' },
  person: { icon: User, tone: 'amber' },
  program: { icon: Link, tone: 'green' },
};

/** The tone of each kind of message, the tint of its glyph in a toast. */
const NOTICE_TONE: Record<NoticeTone, Tone> = { ok: 'green', info: 'blue', warn: 'amber', error: 'red' };

/** The control glyphs drawn inside the kit's components. */
const CONTROL: Record<ControlGlyph, LucideIcon> = {
  search: Search,
  close: X,
  choose: ChevronDown,
  tick: Check,
  previous: ChevronLeft,
  next: ChevronRight,
  zoomIn: ZoomIn,
  zoomOut: ZoomOut,
  fit: Maximize2,
  download: Download,
  quote: Quote,
  enter: CornerDownLeft,
};

/** A neutral tile: the inset ground with a hairline, for a glyph that carries no state. */
const NEUTRAL_TILE = 'bg-app-inset ring-1 ring-inset ring-app-border';

const keys = <K extends string>(record: Record<K, unknown>) => Object.keys(record) as K[];

function GlyphCard({ glyph, tile, name, meaning }: { glyph: ReactNode; tile: string; name: string; meaning: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2.5 rounded-lg border border-app-border bg-surface p-3.5">
      <span className={clsx('inline-flex h-9 w-9 items-center justify-center rounded-lg', tile)}>{glyph}</span>
      <div className="min-w-0">
        <p className="text-prose font-semibold leading-5 text-app-text">{name}</p>
        <p className="mt-0.5 text-compact leading-4 text-app-text-secondary">{meaning}</p>
      </div>
    </div>
  );
}

function Group({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <h2 className="mb-2.5 text-mini font-semibold uppercase tracking-[0.08em] text-app-text-tertiary">
        {title}
        <span className="font-normal normal-case tracking-normal"> · {note}</span>
      </h2>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-[repeat(auto-fill,minmax(176px,1fr))]">{children}</div>
    </section>
  );
}

const icon = (Glyph: LucideIcon, className?: string) => <Glyph size={17} className={className} aria-hidden="true" />;

export function IconLegend({ copy }: { copy: UiCopy }) {
  const l = copy.kit.legend;
  const navGlyphs = new Set<LucideIcon>(Object.values(NAV_ICON));
  /* A tab that opens a surface wears that surface's glyph: only the others are new. */
  const ownTabs = keys(TAB_ICON).filter((k: UiTabKind) => !navGlyphs.has(TAB_ICON[k]));
  const group = (id: LegendGroup, children: ReactNode) => (
    <Group key={id} title={l.groups[id].title} note={l.groups[id].note}>{children}</Group>
  );
  return (
    <div className="h-full max-h-[100dvh] w-full max-w-[100vw]">
      <AppFrame>
        <PaneHeader crumbs={[{ label: l.crumb }, { label: l.title }]}>
          <span className="hidden text-compact text-app-text-tertiary md:inline">{l.lead}</span>
        </PaneHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-6 px-4 py-5 sm:px-6">
            {group('blocks', keys(BLOCK).map((k) => (
              <GlyphCard key={k} glyph={icon(BLOCK[k].icon)} tile={TONE_CHIP[BLOCK[k].tone]} {...l.block[k]} />
            )))}
            {group('data', keys(FIELD_ICON).map((k: FieldKind) => (
              <GlyphCard key={k} glyph={icon(FIELD_ICON[k], TONE_TEXT[FIELD_TONE[k]])} tile={NEUTRAL_TILE} {...l.field[k]} />
            )))}
            {group('surfaces', keys(NAV_ICON).map((k: NavKind) => (
              <GlyphCard key={k} glyph={icon(NAV_ICON[k], 'text-app-text-secondary')} tile={NEUTRAL_TILE} name={copy.shell.nav[k]} meaning={l.surface[k]} />
            )))}
            {group('tabs', ownTabs.map((k) => (
              <GlyphCard key={k} glyph={icon(TAB_ICON[k], 'text-app-text-secondary')} tile={NEUTRAL_TILE} {...l.tab[k]} />
            )))}
            {group('states', (
              <>
                {keys(NOTICE_ICON).map((k: NoticeTone) => (
                  <GlyphCard key={k} glyph={icon(NOTICE_ICON[k])} tile={TONE_CHIP[NOTICE_TONE[k]]} {...l.state[k]} />
                ))}
                <GlyphCard glyph={icon(Lock)} tile={TONE_CHIP.neutral} {...l.state.locked} />
                <GlyphCard glyph={<Spinner size={16} />} tile={TONE_CHIP.neutral} {...l.state.loading} />
              </>
            ))}
            {group('controls', keys(CONTROL).map((k) => (
              <GlyphCard key={k} glyph={icon(CONTROL[k], 'text-app-text-secondary')} tile={NEUTRAL_TILE} {...l.control[k]} />
            )))}
            <div className="rounded-lg bg-app-inset px-4 py-3.5">
              <p className="text-prose font-semibold text-app-text">{l.rulesTitle}</p>
              <p className="mt-1 text-compact leading-6 text-app-text-secondary">{l.rules}</p>
            </div>
          </div>
        </div>
      </AppFrame>
    </div>
  );
}
