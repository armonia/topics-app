import { ChevronLeft, ChevronRight, Copy, Download, Link2, Maximize2, Trash2, X } from 'lucide-react';
import clsx from 'clsx';
import { SegmentedControl } from '../../components/Shared/Segmented';
import type { UiCopy } from '../copy/types';
import type { Action, CrumbModel } from '../types';
import { Button } from '../primitives/Button';
import { Checkbox, Select, TextField, Toggle } from '../primitives/Field';
import { Chip } from '../primitives/Chip';
import { EmptyState } from '../primitives/EmptyState';
import { ProgressBar } from '../primitives/Progress';
import { KeyValue, PanelHeading, PanelSection, SidePanel } from '../primitives/Panel';
import { BackButton, PaneHeader } from '../shell/PaneHeader';
import { FOCUS_RING } from '../shell/pressable';
import { focusOnMount } from '../primitives/overlay';
import { SlideView } from './SlideView';
import type { SlideModel } from './model';

export interface ShareLinkModel {
  id: string;
  to: string;
  url: string;
  /** Already formatted: `31/12/2026`. */
  expires: string;
  at: string;
  code: boolean;
  onCopy: Action;
  onRevoke: Action;
}

export type DeckMode = 'slides' | 'document';

/**
 * A presentation made from a record (a04): the slides as a strip, the slide on
 * a grey desk (or all of them in a column, as a document), the share settings
 * on the right, and the full-pane mode that steps through the slides. The
 * slide shown, the mode and the settings are the caller's; so are the links
 * that were made, which can be copied and revoked.
 */
export function PresentationScreen({
  copy, crumbs, slides, included, onToggleSlide, current, onSelect, mode, onMode, orgLabel, orgMonogram, footer,
  stats, share, links, onShare, onExport, exportDone, job, presenting, onPresent, onExitPresent, onOpenSource,
  onBack, backLabel, status, phone, deniedTitle, generatedAt,
}: {
  copy: UiCopy;
  crumbs: CrumbModel[];
  /** Every slide the record can make, included or not. */
  slides: SlideModel[];
  included: Record<string, boolean>;
  onToggleSlide: (id: string) => void;
  /** Index among the included slides. */
  current: number;
  onSelect: (index: number) => void;
  mode: DeckMode;
  onMode: (m: DeckMode) => void;
  orgLabel: string;
  orgMonogram: string;
  footer: string;
  stats: { slides: number; sources: number };
  share: {
    to: string; onTo: (v: string) => void;
    expires: string; onExpires: (v: string) => void;
    code: boolean; onCode: (v: boolean) => void;
    anonymize: boolean; onAnonymize: (v: boolean) => void;
    style: string; onStyle: (v: string) => void; styles: Array<{ value: string; label: string }>;
    branding: boolean; onBranding: (v: boolean) => void;
  };
  links: ShareLinkModel[];
  onShare: Action;
  onExport: Action;
  /** The PDF was prepared: a way to download it. */
  exportDone?: { label: string; onDownload: () => void };
  /** A share link or a PDF being made. */
  job?: { title: string; progress: number; detail: string };
  presenting: boolean;
  onPresent: Action;
  onExitPresent: () => void;
  onOpenSource: (source: { label: string; id?: string }) => void;
  onBack?: () => void;
  backLabel?: string;
  status: string;
  phone?: boolean;
  deniedTitle?: string;
  generatedAt: string;
}) {
  const d = copy.viewsMore.deck;
  const shown = slides.filter((s) => included[s.id] !== false);
  const index = Math.min(Math.max(current, 0), Math.max(shown.length - 1, 0));
  const slide = shown[index];
  const view = (s: SlideModel, i: number, interactive: boolean) => (
    <SlideView slide={s} copy={copy} index={i} total={shown.length} orgLabel={orgLabel} orgMonogram={orgMonogram} footer={footer} interactive={interactive} onOpenSource={onOpenSource} />
  );

  if (presenting && slide) {
    return (
      <div
        ref={focusOnMount}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') onSelect((index + 1) % shown.length);
          if (e.key === 'ArrowLeft') onSelect((index - 1 + shown.length) % shown.length);
          if (e.key === 'Escape') onExitPresent();
        }}
        className="flex h-full min-h-0 flex-col bg-[#14161a] outline-none"
        aria-label={d.presenting}
      >
        <div className="flex min-h-0 flex-1 items-center justify-center p-4 sm:p-10">
          <div className="w-full max-w-[1100px]">{view(slide, index, true)}</div>
        </div>
        <div className="flex shrink-0 items-center justify-center gap-3 border-t border-white/10 px-4 py-3 text-[#e6e8ec]">
          <button type="button" onClick={() => onSelect((index - 1 + shown.length) % shown.length)} aria-label={d.prev} className={clsx('inline-flex h-8 items-center gap-1 rounded-lg bg-white/10 px-3 text-prose hover:bg-white/15 disabled:opacity-40', FOCUS_RING)}>
            <ChevronLeft size={15} aria-hidden="true" />{d.prev}
          </button>
          <span className="min-w-[72px] text-center text-prose tabular-nums">{d.slideOf(index + 1, shown.length)}</span>
          <button type="button" onClick={() => onSelect((index + 1) % shown.length)} aria-label={d.next} className={clsx('inline-flex h-8 items-center gap-1 rounded-lg bg-white/10 px-3 text-prose hover:bg-white/15 disabled:opacity-40', FOCUS_RING)}>
            {d.next}<ChevronRight size={15} aria-hidden="true" />
          </button>
          <button type="button" onClick={onExitPresent} className={clsx('ml-4 inline-flex h-8 items-center gap-1 rounded-lg bg-white/10 px-3 text-prose hover:bg-white/15', FOCUS_RING)}>
            <X size={15} aria-hidden="true" />{d.exit}
          </button>
        </div>
      </div>
    );
  }

  const strip = (
    <div className={clsx('flex shrink-0 gap-2 bg-app-inset p-2.5', phone ? 'overflow-x-auto border-b border-app-border' : 'w-[170px] flex-col overflow-y-auto border-r border-app-border')} role="list" aria-label={d.stripLabel}>
      {shown.map((s, i) => {
        const on = i === index;
        return (
          <button
            key={s.id}
            type="button"
            role="listitem"
            aria-current={on ? 'true' : undefined}
            onClick={() => onSelect(i)}
            className={clsx('relative shrink-0 rounded-md text-left transition-shadow', phone ? 'w-[140px]' : 'w-full', FOCUS_RING, on ? 'ring-2 ring-primary' : 'ring-1 ring-app-border hover:ring-app-border-light')}
            data-tip={s.name}
          >
            <span className="pointer-events-none block">{view(s, i, false)}</span>
            <span className="absolute inset-x-0 bottom-0 truncate rounded-b-md bg-black/55 px-1.5 py-0.5 text-mini text-white">{i + 1} · {s.name}</span>
          </button>
        );
      })}
    </div>
  );

  const desk = mode === 'slides' ? (
    slide ? (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#dfe1e5] dark:bg-[#26282c]">
        <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto p-4 sm:p-6">
          <div className="w-full max-w-[780px]">{view(slide, index, true)}</div>
        </div>
        <div className="flex shrink-0 items-center justify-center gap-2 border-t border-app-border bg-surface px-3 py-2">
          <Button size="sm" icon={ChevronLeft} onClick={() => onSelect((index - 1 + shown.length) % shown.length)}>{d.prev}</Button>
          <span className="min-w-[72px] text-center text-compact tabular-nums text-app-text-secondary">{d.slideOf(index + 1, shown.length)}</span>
          <Button size="sm" trailing={<ChevronRight size={12} aria-hidden="true" />} onClick={() => onSelect((index + 1) % shown.length)}>{d.next}</Button>
        </div>
      </div>
    ) : (
      <EmptyState title={d.noSlides}>{d.noSlidesBody}</EmptyState>
    )
  ) : (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-[#dfe1e5] p-4 dark:bg-[#26282c] sm:p-6">
      <div className="mx-auto flex max-w-[780px] flex-col gap-5">
        {shown.map((s, i) => <div key={s.id}>{view(s, i, true)}</div>)}
        {shown.length === 0 && <EmptyState title={d.noSlides}>{d.noSlidesBody}</EmptyState>}
      </div>
    </div>
  );

  const side = (
    <>
      <PanelHeading tag={d.shareTag} title={d.shareTitle}>{d.shareBody}</PanelHeading>
      <PanelSection>
        <div className="flex flex-col gap-3">
          <TextField label={d.shareTo} value={share.to} onChange={share.onTo} placeholder={d.shareToPlaceholder} />
          <TextField label={d.shareExpires} type="date" value={share.expires} onChange={share.onExpires} />
          <Toggle checked={share.code} onChange={share.onCode} label={d.shareCode} description={d.shareCodeHint} />
          <Toggle checked={share.anonymize} onChange={share.onAnonymize} label={d.shareAnonymize} description={d.shareAnonymizeHint} />
          <Button variant="primary" icon={Link2} onClick={onShare} title={onShare === false ? deniedTitle : undefined}>{d.share}</Button>
          {job && <ProgressBar value={job.progress} label={job.title} detail={job.detail} />}
        </div>
      </PanelSection>
      {links.length > 0 && (
        <PanelSection label={d.linksTitle(links.length)}>
          <ul className="flex flex-col gap-2.5">
            {links.map((l) => (
              <li key={l.id} className="rounded-lg border border-app-border p-2.5">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-prose font-medium text-app-text">{l.to}</span>
                  {l.code && <Chip tone="blue">{d.withCode}</Chip>}
                </div>
                <div className="mt-0.5 truncate font-mono text-mini text-app-text-tertiary">{l.url}</div>
                <div className="mt-0.5 text-mini text-app-text-tertiary">{d.linkMeta(l.at, l.expires)}</div>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" icon={Copy} onClick={l.onCopy}>{d.copyLink}</Button>
                  <Button size="sm" variant="danger" icon={Trash2} onClick={l.onRevoke}>{d.revoke}</Button>
                </div>
              </li>
            ))}
          </ul>
        </PanelSection>
      )}
      <PanelSection label={d.contains}>
        <KeyValue label={d.slides} value={stats.slides} />
        <KeyValue label={d.sources} value={d.sourcesValue(stats.sources)} />
        <div className="mt-2 flex flex-col gap-0.5">
          {slides.map((s) => (
            <Checkbox key={s.id} label={s.name} checked={included[s.id] !== false} onChange={() => onToggleSlide(s.id)} />
          ))}
        </div>
      </PanelSection>
      <PanelSection label={d.style}>
        <div className="flex flex-col gap-2.5">
          <Select label={d.model} value={share.style} options={share.styles} onChange={share.onStyle} />
          <Toggle checked={share.branding} onChange={share.onBranding} label={d.branding} />
        </div>
      </PanelSection>
      <PanelSection label={d.updates}>
        <p className="text-compact leading-5 text-app-text-secondary">{d.updatesBody(generatedAt)}</p>
      </PanelSection>
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader
        crumbs={crumbs}
        status={phone ? undefined : <Chip tone="green">{status}</Chip>}
        leading={onBack && backLabel ? <BackButton label={backLabel} onClick={onBack} copy={copy} /> : undefined}
      >
        {!phone && (
          <SegmentedControl
            value={mode}
            options={[{ value: 'slides', label: d.modeSlides }, { value: 'document', label: d.modeDocument }]}
            onChange={onMode}
            ariaLabel={d.modeLabel}
          />
        )}
        <Button icon={Maximize2} onClick={onPresent}>{d.present}</Button>
        {!phone && <Button icon={Download} onClick={onExport}>{d.export}</Button>}
        {!phone && <Button variant="primary" icon={Link2} onClick={onShare} title={onShare === false ? deniedTitle : undefined}>{d.share}</Button>}
      </PaneHeader>
      {phone ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-wrap items-center gap-2 border-b border-app-border px-3 py-2">
            <SegmentedControl
              value={mode}
              options={[{ value: 'slides', label: d.modeSlides }, { value: 'document', label: d.modeDocument }]}
              onChange={onMode}
              ariaLabel={d.modeLabel}
            />
            <Button icon={Download} onClick={onExport}>{d.export}</Button>
            <Chip tone="green">{status}</Chip>
          </div>
          {exportDone && <div className="flex items-center gap-2 border-b border-app-border px-3 py-2"><Button size="sm" icon={Download} onClick={exportDone.onDownload}>{exportDone.label}</Button></div>}
          {mode === 'slides' && strip}
          <div className="flex">{desk}</div>
          <div className="border-t border-app-border bg-surface">{side}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {mode === 'slides' && strip}
          {desk}
          <SidePanel
            width={300}
            footer={exportDone ? <Button className="w-full" icon={Download} onClick={exportDone.onDownload}>{exportDone.label}</Button> : undefined}
          >
            {side}
          </SidePanel>
        </div>
      )}
    </div>
  );
}
