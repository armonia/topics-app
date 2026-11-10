import { useState } from 'react';
import { Check, FileText, Layers, MessageSquarePlus, Presentation, RotateCcw, Ruler, ShieldAlert, Trash2, X } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import type { Action, CrumbModel } from '../types';
import { Button, IconButton } from '../primitives/Button';
import { Checkbox, TextField } from '../primitives/Field';
import { Chip } from '../primitives/Chip';
import { KeyValue, PanelHeading, PanelSection, SidePanel } from '../primitives/Panel';
import { Popover } from '../primitives/Popover';
import { TONE_CHIP } from '../tone';
import { BackButton, PaneHeader } from '../shell/PaneHeader';
import { FOCUS_RING } from '../shell/pressable';
import { CadSheet, type CadTool } from './CadSheet';
import type { CadMeasureModel, CadNoteModel, CadPoint, CadRuleModel, CadSheetModel, MapDecisionModel } from './model';

const FLOAT = 'inline-flex h-7 items-center gap-1.5 rounded-md border border-white/10 bg-[#2a2d33] px-2.5 text-compact text-[#e6e8ec] transition-colors hover:bg-[#33373e]';

/** A tool button of the drawing's toolbar; `aria-pressed` says whether it is the tool in hand. */
function ToolButton({ pressed, onClick, icon: Icon, children }: { pressed: boolean; onClick: () => void; icon: typeof Ruler; children: string }) {
  return (
    <button type="button" aria-pressed={pressed} onClick={onClick} className={clsx(FLOAT, FOCUS_RING, pressed && 'border-sky-400/60 bg-sky-500/25 text-white')}>
      <Icon size={13} aria-hidden="true" />
      {children}
    </button>
  );
}

/**
 * A technical drawing checked against the regulation (a03): the sheet on the
 * left with its layers, a measure tool and notes the reader adds, and on the
 * right the rules with what was read from the sheet, the originals, and the
 * draft that asks for what is missing. The rules come from the dimensions
 * drawn on the sheet, so a measure and its verdict never disagree.
 */
export function CadViewScreen({
  copy, crumbs, sheet, rules, hiddenLayers, onToggleLayer, tool, onTool, measures, pending, onPoint, onDeleteMeasure, onClearMeasures,
  notes, onNoteText, onDeleteNote, originals, onOpenOriginal, draft, onUseDraft, draftUsed, decision, onReopen,
  onConform, onRequest, onPresentation, onBack, backLabel, deniedTitle, phone, scale,
}: {
  copy: UiCopy;
  crumbs: CrumbModel[];
  sheet: CadSheetModel;
  rules: CadRuleModel[];
  hiddenLayers: string[];
  onToggleLayer: (id: string) => void;
  tool: CadTool;
  onTool: (t: CadTool) => void;
  measures: CadMeasureModel[];
  pending?: CadPoint;
  onPoint: (p: CadPoint) => void;
  onDeleteMeasure: (id: string) => void;
  onClearMeasures: () => void;
  notes: CadNoteModel[];
  onNoteText: (id: string, text: string) => void;
  onDeleteNote: (id: string) => void;
  originals: Array<{ id: string; label: string; note?: string }>;
  onOpenOriginal?: (id: string) => void;
  draft: string;
  onUseDraft: Action;
  /** The draft already went into the record. */
  draftUsed: boolean;
  decision?: MapDecisionModel;
  onReopen?: Action;
  onConform?: Action;
  onRequest?: Action;
  onPresentation?: Action;
  onBack?: () => void;
  backLabel?: string;
  deniedTitle?: string;
  phone?: boolean;
  /** Printed under the drawing: the scale and what the grid is. */
  scale: string;
}) {
  const c = copy.viewsMore.cad;
  const [layersOpen, setLayersOpen] = useState(false);
  const okCount = rules.filter((r) => r.ok).length;
  const quotesOn = !hiddenLayers.includes('quote');
  const decide = decision ? (
    onReopen !== undefined && <Button icon={RotateCcw} onClick={onReopen} title={deniedTitle}>{copy.viewsMore.parcel.reopen}</Button>
  ) : (
    <>
      <Button variant="danger" icon={ShieldAlert} onClick={onRequest} title={deniedTitle}>{c.request}</Button>
      <Button variant="confirm" icon={Check} onClick={onConform} title={deniedTitle}>{c.conform}</Button>
    </>
  );
  const drawing = (
    <section className={clsx('relative min-w-0 overflow-hidden bg-[#1b1d21]', phone ? 'h-[420px] shrink-0' : 'flex-1')}>
      <CadSheet sheet={sheet} hidden={hiddenLayers} tool={tool} measures={measures} pending={pending} notes={notes} onPoint={onPoint} label={c.drawingLabel} />
      <div className="absolute left-3 top-3 flex max-w-[calc(100%-24px)] flex-wrap gap-1.5">
        <span className="relative">
          <button type="button" aria-expanded={layersOpen} onClick={() => setLayersOpen(true)} className={clsx(FLOAT, FOCUS_RING)}>
            <Layers size={13} aria-hidden="true" />
            {c.layers(sheet.layers.length - hiddenLayers.length, sheet.layers.length)}
          </button>
          {layersOpen && (
            <Popover ariaLabel={c.layersTitle} onClose={() => setLayersOpen(false)} className="w-[230px] p-2">
              <div className="mb-1 px-1 text-mini font-semibold uppercase tracking-[0.08em] text-app-text-tertiary">{c.layersTitle}</div>
              {sheet.layers.map((l) => (
                <div key={l.id} className="flex items-center gap-2 px-1">
                  <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: l.color }} />
                  <Checkbox label={l.label} checked={!hiddenLayers.includes(l.id)} onChange={() => onToggleLayer(l.id)} />
                </div>
              ))}
            </Popover>
          )}
        </span>
        <span className={clsx(FLOAT, 'cursor-default border-amber-500/40 bg-[#3a2a12] text-[#f0b35a] hover:bg-[#3a2a12]')}>{c.exampleMeasures}</span>
        <button
          type="button" aria-pressed={quotesOn} onClick={() => onToggleLayer('quote')}
          className={clsx(FLOAT, FOCUS_RING)}
        >
          {c.quotes}
          {quotesOn && <Check size={12} aria-hidden="true" />}
        </button>
        <ToolButton pressed={tool === 'measure'} icon={Ruler} onClick={() => onTool(tool === 'measure' ? 'view' : 'measure')}>{c.measure}</ToolButton>
        <ToolButton pressed={tool === 'note'} icon={MessageSquarePlus} onClick={() => onTool(tool === 'note' ? 'view' : 'note')}>{c.note}</ToolButton>
      </div>
      <p className="absolute bottom-3 left-3 max-w-[calc(100%-24px)] rounded-md border border-white/10 bg-[#2a2d33]/95 px-2.5 py-1 text-compact text-[#c8cbd2]">
        {tool === 'measure' ? (pending ? c.hintMeasureSecond : c.hintMeasureFirst) : tool === 'note' ? c.hintNote : scale}
      </p>
    </section>
  );
  const panel = (
    <>
      {decision && (
        <div className="border-b border-app-border px-4 py-3">
          <Chip tone={decision.tone} icon={decision.tone === 'green' ? Check : X}>{decision.text}</Chip>
          <p className="mt-1.5 text-compact text-app-text-secondary">{decision.detail}</p>
        </div>
      )}
      <PanelHeading tag={c.rulesTag} title={c.rulesTitle(okCount, rules.length)}>{c.rulesBody}</PanelHeading>
      <PanelSection>
        <div className="overflow-hidden rounded-lg border border-app-border text-compact">
          <div className="grid grid-cols-[1.3fr_1fr_1fr_44px] bg-app-inset px-2.5 py-1.5 font-medium text-app-text-secondary">
            <span>{c.colRule}</span><span>{c.colRequired}</span><span>{c.colFound}</span><span />
          </div>
          {rules.map((r) => (
            <div key={r.id} className="grid grid-cols-[1.3fr_1fr_1fr_44px] items-center border-t border-app-border px-2.5 py-2">
              <span className="pr-2 text-app-text">{r.label}</span>
              <span className="text-app-text-secondary">{r.required}</span>
              <span className={clsx('font-semibold', r.ok ? 'text-app-text' : 'text-rose-600 dark:text-rose-400')}>{r.found}</span>
              <Chip tone={r.ok ? 'green' : 'red'}>{r.ok ? c.ok : c.no}</Chip>
            </div>
          ))}
        </div>
      </PanelSection>
      <PanelSection label={c.measuresTitle}>
        {measures.length === 0 ? (
          <p className="text-compact text-app-text-tertiary">{c.measuresEmpty}</p>
        ) : (
          <>
            {measures.map((m, i) => (
              <KeyValue
                key={m.id}
                label={c.measureN(i + 1)}
                value={(
                  <span className="inline-flex items-center gap-1.5">
                    <span className="font-semibold">{m.label}</span>
                    <IconButton icon={Trash2} label={c.deleteMeasure(i + 1)} onClick={() => onDeleteMeasure(m.id)} className="!h-6 !w-6 border-0 bg-transparent shadow-none" />
                  </span>
                )}
              />
            ))}
            <div className="mt-1"><Button size="sm" variant="ghost" onClick={onClearMeasures}>{c.clearMeasures}</Button></div>
          </>
        )}
      </PanelSection>
      <PanelSection label={c.notesTitle}>
        {notes.length === 0 ? (
          <p className="text-compact text-app-text-tertiary">{c.notesEmpty}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {notes.map((n, i) => (
              <div key={n.id} className="flex items-center gap-2">
                <span aria-hidden="true" className={clsx('inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-mini font-bold', TONE_CHIP.blue)}>{i + 1}</span>
                <TextField size="sm" value={n.text} onChange={(t) => onNoteText(n.id, t)} placeholder={c.noteDefault(i + 1)} className="flex-1" />
                <IconButton icon={Trash2} label={c.deleteNote(i + 1)} onClick={() => onDeleteNote(n.id)} className="!h-6 !w-6 border-0 bg-transparent shadow-none" />
              </div>
            ))}
          </div>
        )}
      </PanelSection>
      <PanelSection label={copy.views.originals}>
        {originals.map((o) => (
          <KeyValue
            key={o.id}
            lead={<FileText size={14} className="text-app-text-tertiary" aria-hidden="true" />}
            label={o.label}
            hint={o.note}
            value={(
              <button type="button" onClick={() => onOpenOriginal?.(o.id)} className={clsx('inline-flex h-5 items-center gap-1 rounded px-1.5 text-mini leading-4 hover:bg-sky-500/20', TONE_CHIP.blue, FOCUS_RING)}>
                <FileText size={12} aria-hidden="true" />
                {copy.common.open}
              </button>
            )}
          />
        ))}
      </PanelSection>
      <PanelSection label={c.draftTitle}>
        <p className="rounded-lg bg-black/[0.04] p-3 text-prose leading-6 text-app-text dark:bg-white/[0.06]">{draft}</p>
        <div className="mt-2.5">
          {draftUsed ? <Chip tone="green" icon={Check}>{c.draftUsed}</Chip> : <Button size="sm" onClick={onUseDraft} title={deniedTitle}>{c.useDraft}</Button>}
        </div>
      </PanelSection>
    </>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={crumbs} leading={onBack && backLabel ? <BackButton label={backLabel} onClick={onBack} copy={copy} /> : undefined}>
        {!phone && <Button icon={Presentation} onClick={onPresentation}>{copy.views.createPresentation}</Button>}
        {!phone && decide}
      </PaneHeader>
      {phone ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-wrap gap-2 border-b border-app-border px-3 py-2">
            <Button icon={Presentation} onClick={onPresentation}>{copy.views.createPresentation}</Button>
            {decide}
          </div>
          {drawing}
          <div className="border-t border-app-border bg-surface">{panel}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {drawing}
          <SidePanel width={400}>{panel}</SidePanel>
        </div>
      )}
    </div>
  );
}
