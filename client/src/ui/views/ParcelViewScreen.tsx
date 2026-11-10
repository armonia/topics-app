import { Check, FileText, Layers, Presentation, RotateCcw, X } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import type { Action, SourceModel } from '../types';
import { TONE_CHIP } from '../tone';
import { Button } from '../primitives/Button';
import { Chip } from '../primitives/Chip';
import { KeyValue, PanelHeading, PanelSection, SidePanel } from '../primitives/Panel';
import { RichText } from '../primitives/RichText';
import { BackButton, PaneHeader } from '../shell/PaneHeader';
import { ParcelMap } from './ParcelMap';
import type { MapDecisionModel, MapPart, ParcelViewModel } from './model';

const FLOATING = 'inline-flex h-7 items-center gap-1.5 rounded-md border border-app-border bg-surface/95 px-2.5 text-compact text-app-text shadow-sm';

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60';
const OPEN_CHIP = 'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 text-mini leading-4 transition-colors hover:bg-sky-500/20';

/**
 * The map's layer switches, floating over its top-left corner. With
 * `onToggle` the layers that draw something are real toggles and the others,
 * which have nothing to draw, are disabled; without it they are a picture.
 */
function LayerBar({ layers, on, onToggle, copy }: {
  layers: ParcelViewModel['layers'];
  on: (id: string) => boolean;
  onToggle?: (layerId: string) => void;
  copy: UiCopy;
}) {
  return (
    <div className="absolute left-3 top-3 flex max-w-[calc(100%-24px)] flex-wrap gap-1.5" role="group" aria-label={copy.views.layers}>
      <span className={clsx(FLOATING, 'font-medium')}><Layers size={13} aria-hidden="true" />{copy.views.layers}</span>
      {layers.map((l) => {
        const isOn = on(l.id);
        const toggle = onToggle && l.part !== undefined ? () => onToggle(l.id) : undefined;
        const toggles = toggle !== undefined;
        const inert = onToggle !== undefined && l.part === undefined;
        return (
          <button
            key={l.id}
            type="button"
            aria-pressed={isOn}
            disabled={inert || undefined}
            onClick={toggle}
            className={clsx(FLOATING, !isOn && 'text-app-text-secondary', toggles && ['transition-colors hover:bg-app-hover', FOCUS], inert && 'cursor-default opacity-45')}
          >
            {l.label}
            {isOn && <Check size={12} className="text-primary dark:text-primary-dark" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A record checked on the map (a02): the GIS layer with the parcels the appeal
 * is about, and next to it the question, the checks with their outcome, the
 * originals to open, and what goes into the record once someone confirms.
 * Every handler is optional and the screen is a picture without them. The
 * container owns which layers are on (`layersOn`, overriding the model) and
 * switching one off hides the part of the map it draws; `onOpenSource` and
 * `onOpenOriginal` make the citations and the "open" chips real buttons.
 */
export function ParcelViewScreen({ view, copy, onBack, backLabel, onConfirm, onReject, onPresentation, layersOn, onToggleLayer, onOpenSource, onOpenOriginal, decision, onReopen, confirmTitle, phone }: {
  view: ParcelViewModel;
  copy: UiCopy;
  onBack?: () => void;
  backLabel?: string;
  onConfirm?: Action;
  /** «Not in the perimeter»: asks why before it records. */
  onReject?: Action;
  onPresentation?: Action;
  layersOn?: string[];
  onToggleLayer?: (layerId: string) => void;
  onOpenSource?: (s: SourceModel) => void;
  onOpenOriginal?: (id: string) => void;
  /** Once someone decided, the answer stands at the top of the panel and the two buttons give way to «reopen». */
  decision?: MapDecisionModel;
  onReopen?: Action;
  /** Why the decision buttons are off for this person. */
  confirmTitle?: string;
  phone?: boolean;
}) {
  const v = copy.views;
  const p = view.panel;
  const isOn = (id: string) => (layersOn ? layersOn.includes(id) : (view.layers.find((l) => l.id === id)?.on ?? false));
  // A picture draws every part; the parts only go away once a layer can be switched.
  const hidden: MapPart[] = layersOn || onToggleLayer
    ? view.layers.flatMap((l) => (l.part && !isOn(l.id) ? [l.part] : []))
    : [];
  const ortho = view.layers.some((l) => l.part === 'ortho' && isOn(l.id));
  const m = copy.viewsMore.parcel;
  const decideButtons = decision ? (
    onReopen !== undefined && <Button icon={RotateCcw} onClick={onReopen} title={confirmTitle}>{m.reopen}</Button>
  ) : (
    <>
      <Button icon={X} onClick={onReject} title={confirmTitle}>{view.rejectLabel}</Button>
      <Button variant="confirm" icon={Check} onClick={onConfirm} title={confirmTitle}>{view.confirmLabel}</Button>
    </>
  );
  const panel = (
    <>
      {decision && (
        <div className="border-b border-app-border px-4 py-3">
          <Chip tone={decision.tone} icon={decision.tone === 'green' ? Check : X}>{decision.text}</Chip>
          <p className="mt-1.5 text-compact text-app-text-secondary">{decision.detail}</p>
        </div>
      )}
      <PanelHeading tag={v.map} title={p.title}>
        <RichText text={p.claim} pageLabel={copy.common.page} onOpenSource={onOpenSource} />
      </PanelHeading>
      <PanelSection label={v.checks}>
        {p.checks.map((c) => (
          <KeyValue key={c.label} label={c.label} value={c.tone ? <Chip tone={c.tone}>{c.value}</Chip> : <span className="font-semibold">{c.value}</span>} />
        ))}
      </PanelSection>
      <PanelSection label={v.originals}>
        {p.originals.map((o) => (
          <KeyValue
            key={o.id}
            lead={<FileText size={14} className="text-app-text-tertiary" aria-hidden="true" />}
            label={o.label}
            value={onOpenOriginal ? (
              <button type="button" onClick={() => onOpenOriginal(o.id)} className={clsx(OPEN_CHIP, TONE_CHIP.blue, FOCUS)}>
                <FileText size={12} className="shrink-0" aria-hidden="true" />
                {copy.common.open}
              </button>
            ) : <Chip tone="blue" icon={FileText}>{copy.common.open}</Chip>}
          />
        ))}
      </PanelSection>
      <PanelSection label={p.outcomeLabel}>
        <p className="text-prose leading-6 text-app-text-secondary">{p.outcome}</p>
      </PanelSection>
    </>
  );
  const map = (
    <section className={clsx('relative min-w-0 overflow-hidden', phone ? 'h-[420px] shrink-0' : 'flex-1')}>
      <ParcelMap map={view.map} label={p.title} hidden={hidden} ortho={ortho} />
      <LayerBar layers={view.layers} on={isOn} onToggle={onToggleLayer} copy={copy} />
      <p className={clsx(FLOATING, 'absolute bottom-3 left-3 max-w-[calc(100%-24px)] text-app-text-secondary')}>
        <RichText text={view.caption} pageLabel={copy.common.page} />
      </p>
    </section>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={view.crumbs} leading={onBack && backLabel ? <BackButton label={backLabel} onClick={onBack} copy={copy} /> : undefined}>
        {!phone && <Button icon={Presentation} onClick={onPresentation}>{v.createPresentation}</Button>}
        {!phone && decideButtons}
      </PaneHeader>
      {phone ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-wrap gap-2 border-b border-app-border px-3 py-2">
            <Button icon={Presentation} onClick={onPresentation}>{v.createPresentation}</Button>
            {decideButtons}
          </div>
          {map}
          <div className="border-t border-app-border bg-surface">{panel}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {map}
          <SidePanel width={380}>{panel}</SidePanel>
        </div>
      )}
    </div>
  );
}
