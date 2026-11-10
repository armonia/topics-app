import type { ReactNode } from 'react';
import { ArrowRight, CircleCheck, ExternalLink, FileSignature, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { SegmentedControl } from '../../components/Shared/Segmented';
import type { UiCopy } from '../copy/types';
import type { CrumbModel, RichTextModel } from '../types';
import { Button } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { KeyValue, PanelHeading, PanelSection } from '../primitives/Panel';
import { Spinner } from '../primitives/Progress';
import { RichText } from '../primitives/RichText';
import { PaneHeader } from '../shell/PaneHeader';
import { FOCUS_RING } from '../shell/pressable';
import type { UsageGroupModel } from './model';
import { PanelColumn } from './PanelColumn';

export type OriginalTab = 'card' | 'original' | 'text';

export interface OriginalPaperModel {
  /** The running head of the page, in small capitals. */
  heading: string;
  /** What the publication says about the act. */
  publication: Array<{ label: string; value: string; mono?: boolean }>;
  /** The paragraphs of the page when the original is loaded; the marked one is the passage cited. */
  paragraphs?: Array<{ text: string; mark?: boolean }>;
  page?: number;
  /** When the text of the original is not loaded: why, in a sentence. */
  notLoaded?: string;
}

export interface OriginalModel {
  crumbs: CrumbModel[];
  title: string;
  /** The description under the title of the side panel. */
  description: string;
  paper: OriginalPaperModel;
  /** The facts of the card tab. */
  facts: Array<{ label: string; value: string; pending?: boolean }>;
  /** The articles listed under the facts, each opening the document at it. */
  articles: Array<{ id: string; heading: string; note: string; pending?: boolean }>;
  /** The text extracted, page by page, for the third tab. */
  extracted: Array<{ id: string; heading: string; page?: number; text?: RichTextModel; subject?: string }>;
  source: Array<{ label: string; value: string; mono?: boolean }>;
  site?: { label: string; check: string; ok: boolean; at?: string };
  refs: Array<{ id: string; label: string; pending?: boolean; openable: boolean }>;
  cited: UsageGroupModel[];
}

/** The page as the publication prints it: serif text on paper, the cited passage marked. */
function PaperPage({ paper, copy }: { paper: OriginalPaperModel; copy: UiCopy }) {
  const o = copy.knowledgeMore.original;
  return (
    <div className="mx-auto max-w-[720px] rounded-lg bg-white px-6 py-8 font-serif text-body-lg leading-7 text-neutral-900 shadow-[0_1px_3px_rgba(0,0,0,0.12)] ring-1 ring-black/5 md:px-14" data-paper="true">
      <div className="font-sans text-mini font-medium tracking-[0.06em] text-neutral-500">{paper.heading}</div>
      {paper.paragraphs ? (
        <div className="mt-3 space-y-2.5">
          {paper.paragraphs.map((p, i) => (
            <p key={i}>{p.mark ? <mark className="rounded-sm bg-sky-500/20 px-0.5 text-inherit">{p.text}</mark> : p.text}</p>
          ))}
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <dl className="space-y-1.5">
            {paper.publication.map((r) => (
              <div key={r.label} className="flex flex-wrap gap-x-3">
                <dt className="w-44 shrink-0 font-sans text-compact text-neutral-500">{r.label}</dt>
                <dd className={clsx('min-w-0 flex-1 font-semibold', r.mono && 'font-mono text-compact')}>{r.value}</dd>
              </div>
            ))}
          </dl>
          <div className="rounded-md border border-dashed border-amber-600/50 bg-amber-50 px-4 py-3 font-sans text-prose leading-6 text-amber-900">
            <div className="font-semibold">{o.notLoadedTitle}</div>
            {paper.notLoaded}
          </div>
          <div className="flex items-center gap-2 border-t border-neutral-200 pt-3 font-sans text-compact text-neutral-500">
            <FileSignature size={14} aria-hidden="true" />
            {o.signatureUnknown}
          </div>
        </div>
      )}
      {paper.page !== undefined && paper.paragraphs && <div className="mt-3 text-right font-sans text-compact text-neutral-500">{o.page(paper.page)}</div>}
    </div>
  );
}

/**
 * The signed original of a document and who cites it (v03): the page as it
 * was published in the middle, the facts of the publication, what it refers
 * to and what cites it on the right. Three tabs: the card of the document,
 * the original page, the text extracted from it. Every row that names another
 * document or a case opens it through the caller.
 */
export function OriginalScreen({
  copy, phone, model, tab, onTab, onOpenSite, onRecheck, onOpenRef, onOpenCited, onOpenArticle, onLoadOriginal, onBack, checking,
}: {
  copy: UiCopy;
  phone?: boolean;
  model: OriginalModel;
  tab: OriginalTab;
  onTab: (t: OriginalTab) => void;
  /** Opens the original on the web; `undefined` when the original is not on a site. */
  onOpenSite?: () => void;
  onRecheck?: () => void;
  onOpenRef: (id: string) => void;
  onOpenCited: (groupId: string, rowId: string) => void;
  onOpenArticle: (articleId: string) => void;
  /** Loads the missing text, from the page that says it is missing. */
  onLoadOriginal?: () => void;
  onBack?: ReactNode;
  /** The check against the site is running. */
  checking?: boolean;
}) {
  const o = copy.knowledgeMore.original;
  const m = model;
  const center = (() => {
    if (tab === 'card') {
      return (
        <div className="mx-auto max-w-[720px] space-y-4">
          <h2 className="text-headline font-semibold tracking-[-0.01em] text-app-text">{m.title}</h2>
          <Card title={o.cardFacts}>
            {m.facts.map((f) => <KeyValue key={f.label} label={f.label} value={f.pending ? <Chip tone="amber">{f.value}</Chip> : <span className="font-semibold">{f.value}</span>} />)}
          </Card>
          <Card title={o.cardTitle}>
            <ul className="-mx-2 space-y-0.5">
              {m.articles.map((a) => (
                <li key={a.id}>
                  <button type="button" onClick={() => onOpenArticle(a.id)} className={clsx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-app-hover', FOCUS_RING)}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-prose font-medium text-app-text">{a.heading}</span>
                      <span className="block truncate text-compact text-app-text-tertiary">{a.note}</span>
                    </span>
                    {a.pending && <Chip tone="amber">{copy.knowledgeMore.doc.textToLoad}</Chip>}
                    <ArrowRight size={14} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      );
    }
    if (tab === 'text') {
      return (
        <div className="mx-auto max-w-[720px] space-y-3">
          <h2 className="text-headline font-semibold tracking-[-0.01em] text-app-text">{o.extractedTitle}</h2>
          <p className="text-prose text-app-text-secondary">{o.extractedNote}</p>
          {m.extracted.map((e) => (
            <Card key={e.id} title={e.heading} actions={e.page !== undefined ? <Chip>{o.page(e.page)}</Chip> : undefined}>
              {e.text ? <RichText text={e.text} pageLabel={copy.common.page} /> : <span>{e.subject}<span className="ml-2 inline-block"><Chip tone="amber">{copy.knowledgeMore.doc.textToLoad}</Chip></span></span>}
            </Card>
          ))}
        </div>
      );
    }
    return (
      <div>
        <PaperPage paper={m.paper} copy={copy} />
        {!m.paper.paragraphs && onLoadOriginal && (
          <div className="mx-auto mt-4 flex max-w-[720px] flex-wrap items-center gap-3">
            <Button variant="primary" onClick={onLoadOriginal}>{o.loadOriginal}</Button>
            <span className="text-compact text-app-text-tertiary">{o.loadOriginalHint}</span>
          </div>
        )}
      </div>
    );
  })();
  const buttons = (
    <>
        <SegmentedControl
          value={tab}
          onChange={onTab}
          ariaLabel={o.tabsLabel}
          options={[{ value: 'card', label: o.tabs.card }, { value: 'original', label: o.tabs.original }, { value: 'text', label: o.tabs.text }]}
        />
        {onOpenSite && <Button icon={ExternalLink} onClick={onOpenSite}>{o.openSite}</Button>}
    </>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={m.crumbs} leading={onBack}>{!phone && buttons}</PaneHeader>
      {phone && <div className="flex flex-wrap gap-2 border-b border-app-border px-4 py-2">{buttons}</div>}
      <div className={clsx('flex min-h-0 flex-1', phone ? 'flex-col overflow-y-auto' : 'flex-row')}>
        <div className={clsx('min-w-0 bg-app-inset px-4 py-5 md:px-10 md:py-6', phone ? 'shrink-0' : 'flex-1 overflow-y-auto')}>{center}</div>
        <PanelColumn phone={phone} width={360}>
          <PanelHeading tag={o.panelTag} title={m.title}>{m.description}</PanelHeading>
          <PanelSection label={o.source}>
            {m.source.map((r) => <KeyValue key={r.label} label={r.label} value={<span className={clsx('font-semibold', r.mono && 'font-mono text-compact')}>{r.value}</span>} />)}
            {m.site && (
              <div className="mt-1 space-y-1.5 text-prose text-app-text">
                <div className="break-words">{m.site.label}</div>
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={m.site.ok ? 'green' : 'amber'} icon={CircleCheck}>{m.site.check}</Chip>
                  {onRecheck && (checking ? <Spinner label={o.recheckJob.title} /> : <Button size="sm" icon={RefreshCw} onClick={onRecheck}>{o.recheck}</Button>)}
                </div>
              </div>
            )}
            {m.site?.at && <p className="mt-1 text-mini text-app-text-tertiary">{o.recheckAt(m.site.at)}</p>}
          </PanelSection>
          {m.refs.length > 0 && (
            <PanelSection label={o.refsLabel}>
              {m.refs.map((r) => (
                <div key={r.id} className="flex min-h-7 items-center gap-2 py-0.5 text-prose">
                  <span className="min-w-0 flex-1 text-app-text">{r.label}</span>
                  {r.pending && <Chip tone="amber">{o.refPending}</Chip>}
                  {r.openable && (
                    <button type="button" onClick={() => onOpenRef(r.id)} className={clsx('rounded', FOCUS_RING)}>
                      <Chip tone="blue" icon={ArrowRight}>{o.refOpen}</Chip>
                    </button>
                  )}
                </div>
              ))}
            </PanelSection>
          )}
          <PanelSection label={o.citedBy}>
            {m.cited.some((g) => g.rows.length) ? m.cited.filter((g) => g.rows.length).map((g) => (
              <div key={g.id} className="mb-2 last:mb-0">
                <div className="mb-0.5 text-mini font-medium text-app-text-tertiary">{g.label}</div>
                {g.rows.map((r) => (
                  <div key={r.id} className="flex min-h-7 items-center gap-2 py-0.5 text-prose">
                    <span className="min-w-0 flex-1 truncate text-app-text">{r.title}</span>
                    <button type="button" onClick={() => onOpenCited(g.id, r.id)} className={clsx('rounded', FOCUS_RING)}>
                      <Chip tone="blue" icon={ArrowRight}>{r.detail}</Chip>
                    </button>
                  </div>
                ))}
              </div>
            )) : <p className="text-compact text-app-text-tertiary">{o.citedNone}</p>}
          </PanelSection>
        </PanelColumn>
      </div>
    </div>
  );
}
