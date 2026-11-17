import { contrastRatio, fromHex } from '../../lib/iconTint';
import type { ReactNode } from 'react';
import { useTopicInProgress, useTerminalLoading, useBrowserLoading, useProjectLoading } from '../../state/signals';
import {
  TopicStreamingSpinner, TerminalStreamingSpinner, BrowserStreamingSpinner, ProjectStreamingSpinner,
} from './StreamingIndicator';

function topicInitialForeground(color: string | undefined): string {
  const background = fromHex(color ?? '#6366f1');
  const black = fromHex('#000000')!;
  const white = fromHex('#ffffff')!;
  return background && contrastRatio(background, black) > contrastRatio(background, white) ? '#000000' : '#ffffff';
}

/** The topic's coloured initial: the whole face of a squeezed (square) tab. */
export function TopicInitial({ color, label }: { color: string | undefined; label: string }) {
  const background = color ?? '#6366f1';
  return (
    <span
      data-topic-initial
      aria-hidden="true"
      className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-mini font-semibold leading-none ring-1 ring-white/70"
      style={{ backgroundColor: background, color: topicInitialForeground(background) }}
    >
      {label.trim().slice(0, 1).toUpperCase() || 'N'}
    </span>
  );
}

/** What a squeezed tab is the face of: which subject's work its loader tells. */
export type SquareLoaderSource =
  | { kind: 'topic'; topicId: string }
  | { kind: 'terminal'; sessionId: string }
  | { kind: 'browser'; paneId: string }
  | { kind: 'project'; path: string };

/**
 * The lead mark of an UNSELECTED tab squeezed to its face (TABSLOT-02): the
 * topic's initial, or the icon of a terminal, a browser or a project.
 * Such a tab has no slot (`TabSlot` is not mounted), so a subject at work drew
 * nothing at all. While it works the loader TAKES THE PLACE of the face, inside
 * a box of the SAME footprint the face occupies (`SQUARE_BOX`), so the tab keeps
 * its width when the work starts or ends and no second element has to find room
 * on a tab that has none. The loader is the very spinner of the normal tab
 * (same real action, same 16 px `LoaderSlot`), centred in the box: in the 14 px
 * boxes it overflows by 1 px on each side, symmetric, and costs no layout.
 * At rest the face is back. With no `source` the children are drawn untouched.
 */
export function SquareTabMark({ source, onFill = false, children }: {
  source: SquareLoaderSource | null;
  onFill?: boolean;
  children: ReactNode;
}) {
  if (!source) return <>{children}</>;
  switch (source.kind) {
    case 'topic': return <TopicSwap topicId={source.topicId} onFill={onFill}>{children}</TopicSwap>;
    case 'terminal': return <TerminalSwap sessionId={source.sessionId}>{children}</TerminalSwap>;
    case 'browser': return <BrowserSwap paneId={source.paneId}>{children}</BrowserSwap>;
    case 'project': return <ProjectSwap path={source.path} onFill={onFill}>{children}</ProjectSwap>;
  }
}

/** The face's footprint per kind: the initial's 20 px, the 14 px icon boxes, the browser favicon's 16 px. */
const SQUARE_BOX: Record<SquareLoaderSource['kind'], string> = {
  topic: 'h-5 w-5',
  terminal: 'h-3.5 w-3.5',
  browser: 'h-4 w-4',
  project: 'h-3.5 w-3.5',
};

/** One hook per kind (each reads its own subject's work), one frame for all. */
function Swap({ kind, working, spinner, children }: {
  kind: SquareLoaderSource['kind'];
  working: boolean;
  spinner: ReactNode;
  children: ReactNode;
}) {
  if (!working) return <>{children}</>;
  return (
    <span
      data-testid="square-tab-loader"
      data-square-kind={kind}
      className={`inline-flex ${SQUARE_BOX[kind]} flex-shrink-0 items-center justify-center`}
    >
      {spinner}
    </span>
  );
}

function TopicSwap({ topicId, onFill, children }: { topicId: string; onFill: boolean; children: ReactNode }) {
  return <Swap kind="topic" working={useTopicInProgress(topicId)} spinner={<TopicStreamingSpinner topicId={topicId} onFill={onFill} />}>{children}</Swap>;
}

function TerminalSwap({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  return <Swap kind="terminal" working={useTerminalLoading(sessionId)} spinner={<TerminalStreamingSpinner sessionId={sessionId} />}>{children}</Swap>;
}

function BrowserSwap({ paneId, children }: { paneId: string; children: ReactNode }) {
  return <Swap kind="browser" working={useBrowserLoading(paneId)} spinner={<BrowserStreamingSpinner paneId={paneId} />}>{children}</Swap>;
}

function ProjectSwap({ path, onFill, children }: { path: string; onFill: boolean; children: ReactNode }) {
  return <Swap kind="project" working={useProjectLoading(path)} spinner={<ProjectStreamingSpinner projectPath={path} onFill={onFill} />}>{children}</Swap>;
}
