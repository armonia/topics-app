/**
 * THE FILES OF THE AGENTS' CONTEXT, the lists of the context level (HUBBR-17).
 *
 * The files read at start, grouped as the hub groups them by who loads them
 * (Claude Code, Codex and jcode), each group with its count and its
 * tokens; a row carries who loads it as chips with the hub's qualifier, the
 * hub's note, the tokens and how long ago the file changed (amber past two
 * months). A tap opens the text with the file's place on disk, so it can be
 * found and edited. The skills' listing opens to every skill, heaviest first,
 * the ones worth trimming. The sources read on demand stay closed until asked.
 *
 * Split from ContextLevel.tsx, which keeps the weights, the checks and the
 * level's frame.
 */
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Layers } from 'lucide-react';
import type { useT } from '../../hooks/useT';
import { apiFetch } from '../../lib/shell/net';
import { STALE_FILE_DAYS, fileAgeDays, fileGroups, type ContextFile, type ContextView } from '../../lib/hubContext';
import { DANGER_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { shortTokens } from '../../lib/formatTokens';

export type Tr = ReturnType<typeof useT>;

export const SECTION = 'flex items-center gap-1.5 pb-1 pt-1.5 text-mini font-semibold uppercase tracking-wide text-app-text-secondary';
export const SECTION_HINT = 'ml-auto truncate font-normal normal-case tracking-normal text-app-text-muted';
const GROUP_HEAD = 'flex items-center gap-1.5 pb-0.5 pt-1.5 text-mini text-app-text-secondary';
const CHIP = 'flex-none rounded bg-app-hover px-1 text-mini text-app-text-secondary';

interface FilesProps { view: ContextView; tr: Tr; locale: string; pad: string; isMobile: boolean; now: number }

export function Files({ view, tr, locale, pad, isMobile, now }: FilesProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [showDemand, setShowDemand] = useState(false);
  const demandTokens = view.onDemand.reduce((a, f) => a + f.tokens, 0);
  const row = (f: ContextFile) => (
    <FileRow key={f.id} file={f} tr={tr} locale={locale} isMobile={isMobile} now={now} open={openId === f.id} onToggle={() => setOpenId(openId === f.id ? null : f.id)} />
  );
  const groups = (files: ContextFile[]) => fileGroups(files).map((g) => (
    <div key={g.name} data-testid="context-file-group" data-group={g.name}>
      <div className={GROUP_HEAD}>
        <span className="truncate font-semibold text-app-text">{g.name}</span>
        <span data-testid="context-file-group-meta" className="ml-auto flex-none tabular-nums">
          {tr('hubContext.group.meta', { n: g.files.length, tok: shortTokens(g.tokens, locale) })}
        </span>
      </div>
      {g.files.map(row)}
    </div>
  ));
  return (
    <div data-testid="context-files" className={`${pad} mt-2`}>
      <div className={SECTION}><FileText size={12} aria-hidden="true" />{tr('hubContext.files')}<span className="font-normal tabular-nums">{view.files.length}</span><span className={SECTION_HINT}>{tr('hubContext.files.hint')}</span></div>
      {groups(view.files)}
      {view.skills && <Skills skills={view.skills} tr={tr} locale={locale} isMobile={isMobile} />}
      {view.onDemand.length > 0 && (
        <>
          <button
            type="button"
            data-testid="context-on-demand"
            aria-expanded={showDemand}
            onClick={() => setShowDemand((v) => !v)}
            className="mt-1 flex w-full items-center gap-1.5 py-1 text-left text-mini text-app-text-secondary hover:text-app-text"
          >
            {showDemand ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
            <span className="font-semibold uppercase tracking-wide">{tr('hubContext.onDemand')}</span>
            <span className="tabular-nums">{view.onDemand.length}</span>
            <span className="ml-auto truncate text-app-text-muted">{tr('hubContext.onDemand.hint')} · {tr('hubContext.tok', { n: shortTokens(demandTokens, locale) })}</span>
          </button>
          {showDemand && groups(view.onDemand)}
        </>
      )}
    </div>
  );
}

/** The skills' listing: one row, and on a tap every skill heaviest first with its tokens. */
function Skills({ skills, tr, locale, isMobile }: { skills: NonNullable<ContextView['skills']>; tr: Tr; locale: string; isMobile: boolean }) {
  const [open, setOpen] = useState(false);
  const canOpen = skills.items.length > 0;
  const max = Math.max(1, ...skills.items.map((s) => s.tokens));
  return (
    <div data-testid="context-skills" data-open={open}>
      <button
        type="button"
        aria-expanded={canOpen ? open : undefined}
        disabled={!canOpen}
        onClick={() => setOpen((v) => !v)}
        className={`mt-1 flex w-full items-start gap-2 rounded-sm text-left enabled:hover:bg-app-hover disabled:cursor-default ${isMobile ? 'py-2.5' : 'py-1.5'}`}
      >
        <Layers size={13} className="mt-0.5 flex-none text-app-text-secondary" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-app-text ${isMobile ? 'text-body-lg' : 'text-compact'}`}>{tr('hubContext.skills')}</span>
          <span className="block truncate text-mini text-app-text-secondary">{tr('hubContext.skills.meta', { n: skills.count })}</span>
        </span>
        <span className="mt-0.5 flex flex-none items-center gap-1 text-mini tabular-nums text-app-text-secondary">
          {tr('hubContext.tok', { n: shortTokens(skills.tokens, locale) })}
          {canOpen && <ChevronDown size={12} className={open ? 'rotate-180' : ''} aria-hidden="true" />}
        </span>
      </button>
      {open && (
        <div data-testid="context-skill-list" className="mb-1.5 ml-[21px]">
          <div className="pb-0.5 text-mini text-app-text-muted">{tr('hubContext.skills.heaviest', { n: skills.items.length })}</div>
          {skills.items.map((s) => (
            <div key={s.name} data-testid="context-skill" className="flex items-center gap-2 py-0.5 text-mini">
              <span className="w-[40%] min-w-0 flex-none truncate text-app-text" title={s.name}>{s.name}</span>
              <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-app-border">
                <span className="block h-full rounded-full bg-primary/60" style={{ width: `${Math.max(3, Math.round((s.tokens / max) * 100))}%` }} />
              </span>
              <span className="w-[48px] flex-none text-right tabular-nums text-app-text-secondary">{tr('hubContext.tok', { n: shortTokens(s.tokens, locale) })}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface FileRowProps { file: ContextFile; tr: Tr; locale: string; isMobile: boolean; now: number; open: boolean; onToggle: () => void }

function FileRow({ file, tr, locale, isMobile, now, open, onToggle }: FileRowProps) {
  const [text, setText] = useState<{ state: 'loading' | 'ok' | 'failed'; body: string } | null>(null);
  useEffect(() => {
    if (!open || text) return;
    let alive = true;
    void apiFetch(`/api/hub/context/text?path=${encodeURIComponent(file.path)}`, { cache: 'no-store' })
      .then(async (r) => {
        const body = r.ok ? await r.json() as { text?: unknown } : null;
        if (!alive) return;
        setText(typeof body?.text === 'string' ? { state: 'ok', body: body.text } : { state: 'failed', body: '' });
      })
      .catch(() => { if (alive) setText({ state: 'failed', body: '' }); });
    return () => { alive = false; };
  }, [open, text, file.path]);
  const days = fileAgeDays(file.mtime, now);
  const age = days === null ? null : days < 1 ? tr('hubContext.age.today') : days === 1 ? tr('hubContext.age.yesterday') : tr('hubContext.age.days', { n: days });
  return (
    <div data-testid="context-file" data-open={open}>
      <button type="button" aria-expanded={open} onClick={onToggle} className={`flex w-full items-start gap-2 rounded-sm text-left hover:bg-app-hover ${isMobile ? 'py-2.5' : 'py-1.5'}`}>
        <FileText size={13} className="mt-0.5 flex-none text-app-text-secondary" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-app-text ${isMobile ? 'text-body-lg' : 'text-compact'}`}>{file.label}</span>
          {(file.loaders.length > 0 || file.note) && (
            <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1">
              {file.loaders.map((l) => <span key={l} data-testid="context-file-loader" className={CHIP}>{l}</span>)}
              {file.note && <span className="min-w-0 truncate text-mini text-app-text-secondary" title={file.note}>{file.note}</span>}
            </span>
          )}
        </span>
        <span className="mt-0.5 flex flex-none flex-col items-end text-mini tabular-nums">
          <span className="text-app-text-secondary">{tr('hubContext.tok', { n: shortTokens(file.tokens, locale) })}</span>
          {age && (
            <span data-testid="context-file-age" data-stale={days !== null && days > STALE_FILE_DAYS} title={tr('hubContext.age.title')} className={days !== null && days > STALE_FILE_DAYS ? WARNING_TEXT : 'text-app-text-muted'}>{age}</span>
          )}
        </span>
      </button>
      {open && (
        <div data-testid="context-file-text" className="mb-1.5 ml-[21px] rounded border border-app-border bg-app-inset">
          <div className="flex flex-wrap items-baseline gap-x-2 border-b border-app-border px-2 py-1 text-mini">
            <span data-testid="context-file-path" className="min-w-0 break-all font-mono text-app-text-secondary">{file.path}</span>
            <span className="text-app-text-muted">{tr('hubContext.text.masked')}</span>
          </div>
          <div className="max-h-56 overflow-auto px-2 py-1.5">
            {!text || text.state === 'loading' ? (
              <span className="text-mini text-app-text-muted">{tr('hubContext.text.loading')}</span>
            ) : text.state === 'failed' ? (
              <span className={`text-mini ${DANGER_TEXT}`}>{tr('hubContext.text.failed')}</span>
            ) : (
              <pre className="m-0 whitespace-pre-wrap break-words font-mono text-mini text-app-text-body">{text.body}</pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
