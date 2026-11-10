import { Check, Download, FileText } from 'lucide-react';
import type { ReactNode } from 'react';
import { SegmentedControl } from '../../components/Shared/Segmented';
import type { UiCopy } from '../copy/types';
import type { CrumbModel } from '../types';
import { Chip } from '../primitives/Chip';
import { DocumentViewer } from '../primitives/DocumentViewer';
import { EmptyState } from '../primitives/EmptyState';
import { Tabs } from '../primitives/Tabs';
import { BackButton, PaneHeader } from '../shell/PaneHeader';

export type DocumentMode = 'summary' | 'side' | 'original';

export interface DocumentScreenModel {
  crumbs: CrumbModel[];
  backLabel: string;
  docs: Array<{ id: string; name: string }>;
  activeId: string;
  name: string;
  detail?: string;
  pages: string[];
  pdf?: string;
  /** `firma valida · avv. del ricorrente`. (allow-italian: quotes the Italian interface) */
  signedNote?: string;
  exampleTag: string;
  quote?: { text: string; page: number };
}

/**
 * An original next to what the AI says about it (v01): the documents of the
 * record as tabs, the summary and the page side by side (or one of them
 * alone), the signed file to download. On a phone the original comes first
 * and the summary under it. `summary` is the DocSummary the container builds.
 */
export function DocumentScreen({ model, copy, mode, onMode, page, onPage, zoom, onZoom, summary, onBack, onSelectDoc, onDownload, phone, notice }: {
  model: DocumentScreenModel | undefined;
  copy: UiCopy;
  mode: DocumentMode;
  onMode: (mode: DocumentMode) => void;
  page: number;
  onPage: (n: number) => void;
  zoom: number;
  onZoom: (z: number) => void;
  summary?: ReactNode;
  onBack: () => void;
  onSelectDoc: (id: string) => void;
  onDownload?: () => void;
  phone?: boolean;
  notice?: ReactNode;
}) {
  const d = copy.work.doc;
  if (!model) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PaneHeader crumbs={[{ label: d.notFound }]} />
        <EmptyState icon={FileText} title={d.notFound}>{d.notFoundBody}</EmptyState>
      </div>
    );
  }
  const viewer = (aside?: ReactNode) => (
    <DocumentViewer
      name={model.name}
      detail={model.detail}
      pages={model.pages}
      page={page}
      onPage={onPage}
      zoom={zoom}
      onZoom={onZoom}
      pdfHref={model.pdf}
      quote={model.quote}
      aside={aside}
      copy={copy}
      phone={phone}
    />
  );
  const modes = (
    <SegmentedControl
      value={mode}
      onChange={onMode}
      ariaLabel={d.modes}
      options={[
        { value: 'summary', label: d.onlySummary },
        { value: 'side', label: d.sideBySide },
        { value: 'original', label: d.onlyOriginal },
      ]}
    />
  );
  let body: ReactNode;
  if (phone) {
    body = mode === 'summary'
      ? <div className="min-h-0 flex-1 overflow-y-auto">{summary}</div>
      : viewer(mode === 'original' ? undefined : summary);
  } else if (mode === 'summary') {
    body = <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-[860px]">{summary}</div></div>;
  } else if (mode === 'original') {
    body = viewer();
  } else {
    body = (
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="min-h-0 w-[440px] shrink-0 overflow-y-auto border-r border-app-border bg-surface">{summary}</div>
        {viewer()}
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={model.crumbs} leading={<BackButton label={model.backLabel} onClick={onBack} copy={copy} />}>
        {notice}
        {!phone && modes}
        {!phone && model.pdf && (
          <a
            href={model.pdf}
            download
            onClick={onDownload}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-black/[0.05] px-2.5 text-prose font-medium text-app-text transition-colors hover:bg-black/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 dark:bg-white/[0.08]"
          >
            <Download size={14} aria-hidden="true" />{d.downloadSigned}
          </a>
        )}
      </PaneHeader>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-app-border px-4 pt-1.5">
        <Tabs
          ariaLabel={d.documents}
          value={model.activeId}
          onChange={onSelectDoc}
          options={model.docs.map((x) => ({ value: x.id, label: x.name }))}
          className="min-w-0 flex-1 border-b-0"
        />
        <div className="flex shrink-0 items-center gap-1.5 pb-1.5">
          <Chip>{model.exampleTag}</Chip>
          {model.signedNote && <Chip tone="green" icon={Check}>{model.signedNote}</Chip>}
        </div>
      </div>
      {phone && <div className="shrink-0 px-4 py-2">{modes}</div>}
      {body}
    </div>
  );
}
