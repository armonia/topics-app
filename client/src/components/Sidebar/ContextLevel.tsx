/**
 * THE AGENTS' CONTEXT, a level of System (hub-smistamento, HUBBR-17).
 *
 * What every agent reads before the first word, from the usage hub: the weight
 * per harness (Claude Code about fifteen thousand tokens), the files read at
 * start with who reads them and their text on a tap, the list of skills, the
 * sources read on demand, the lines repeated across files and the rules with
 * an old date. The hub's last check for contradicting rules comes first; a new
 * check makes an agent work, so it asks before it starts, then the level reads
 * the hub again until the agent has answered. What it finds also reaches the
 * bell («Da guardare»).
 *
 * Loaded as its own chunk when the level opens; its strings come with it. A hub
 * that stops answering keeps its last answer on screen with a band and a retry.
 * On the phone the level is the one sheet in sight, with its own way back to
 * System and its own close.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronLeft, CloudOff, Loader2, Scale, Sparkles, Stethoscope, X } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { useMobile } from '../../hooks/useMobile';
import { addCatalogue } from '../../lib/i18n';
import HUB_CONTEXT_IT from '../../lib/i18n-hub-context-it';
import HUB_CONTEXT_EN from '../../lib/i18n-hub-context-en';
import { apiFetch } from '../../lib/shell/net';
import { checkStart, contextView, type ContextView, type DoctorVerdict, type UnlistedRef } from '../../lib/hubContext';
import { HUB_CONTEXT_DOC, useHubDoc } from '../../state/hubDocs';
import { startVisibleInterval } from '../../state/documentVisibility';
import { useCloseLevel } from '../Shared/levelClose';
import { DANGER_TEXT, SUCCESS_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { PALLINO_ATTESA, PALLINO_OK } from './chromeSignals';
import { Files, SECTION, SECTION_HINT, type Tr } from './ContextFiles';
import { shortTokens } from '../../lib/formatTokens';

addCatalogue('it', HUB_CONTEXT_IT);
addCatalogue('en', HUB_CONTEXT_EN);

/** The hub keeps its own copy for a minute: reading more often returns the same answer. */
const MAX_AGE_MS = 60_000;
/** While an agent checks the rules, the level asks the hub again this often. */
const CHECK_POLL_MS = 5_000;
/** While the hub is still running agents-doctor, the level asks again this often, as the hub's page does. */
const DOCTOR_POLL_MS = 8_000;
const RULES_SHOWN = 3;

function useClock(locale: string) {
  return useMemo(() => {
    const tag = locale === 'en' ? 'en-GB' : 'it-IT';
    const time = new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit' });
    const date = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short' });
    return {
      time: (at: number) => time.format(at),
      when: (tr: Tr, at: number) => (new Date(at).toDateString() === new Date().toDateString()
        ? tr('hubContext.when.today', { time: time.format(at) })
        : tr('hubContext.when.day', { date: date.format(at).replace(/\./g, ''), time: time.format(at) })),
    };
  }, [locale]);
}

export interface ContextLevelProps {
  /** Closes the menu: the phone's close button leaves it. */
  onNavigate?: () => void;
}

export function ContextLevel({ onNavigate }: ContextLevelProps) {
  const tr = useT();
  const locale = useLocale();
  const { isMobile } = useMobile();
  const clock = useClock(locale);
  const closeLevel = useCloseLevel();
  const doc = useHubDoc(HUB_CONTEXT_DOC, true, MAX_AGE_MS);
  const unlisted = useCallback(
    (u: UnlistedRef) => tr(u.kind === 'other' && !u.owner ? 'hubContext.where.bare' : `hubContext.where.${u.kind}`, { owner: u.owner, name: u.name }),
    [tr],
  );
  // okAt in the deps: each read re-judges a check left running against the clock.
  const view = useMemo(() => contextView(doc.data, unlisted, Date.now()), [doc.data, doc.okAt, unlisted]);
  const [asking, setAsking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  // From the moment the hub took the request until the first read after it:
  // from then on the hub's own `running` says whether the agent is still at it.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const running = !!view?.check.running || (startedAt !== null && (doc.okAt ?? 0) <= startedAt);
  const { reread } = doc;

  useEffect(() => {
    if (!running) return;
    return startVisibleInterval(() => { void reread(); }, CHECK_POLL_MS);
  }, [running, reread]);

  // A doctor still running is not an answer: read again until the hub has one.
  const doctorPending = view?.doctor?.state === 'pending';
  useEffect(() => {
    if (!doctorPending) return;
    return startVisibleInterval(() => { void reread(); }, DOCTOR_POLL_MS);
  }, [doctorPending, reread]);

  const start = async () => {
    setStarting(true);
    setRefused(null);
    try {
      const r = await apiFetch(`${HUB_CONTEXT_DOC}/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const answer = checkStart(r.status, await r.json().catch(() => null));
      if (answer.ok) {
        setAsking(false);
        setStartedAt(Date.now());
        void reread();
      } else {
        setRefused(answer.why);
      }
    } catch (e) {
      setRefused(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const pad = isMobile ? 'px-4' : 'px-3';
  const down = doc.state === 'down';
  const freshness = (
    <span data-testid="context-freshness" className="flex items-center gap-1.5 text-mini text-app-text-secondary">
      <span className={`h-1.5 w-1.5 rounded-full ${down ? PALLINO_ATTESA : PALLINO_OK}`} />
      {doc.okAt === null ? tr('hubContext.reading') : tr('hubContext.readAt', { time: clock.time(doc.okAt) })}
    </span>
  );

  return (
    <div data-testid="context-level" className="flex min-w-0 flex-col">
      {isMobile ? (
        <>
          <div className="relative flex h-11 items-center px-1">
            <button type="button" data-testid="context-back" onClick={closeLevel} className="flex h-11 items-center gap-0.5 px-2 text-body-lg text-primary">
              <ChevronLeft size={18} aria-hidden="true" />{tr('hubContext.back')}
            </button>
            <span className="pointer-events-none absolute inset-x-0 text-center text-body-lg font-semibold text-app-text">{tr('hubContext.open')}</span>
            <button type="button" data-testid="context-close" aria-label={tr('hubContext.close')} onClick={() => onNavigate?.()} className="ml-auto grid h-11 w-11 place-items-center text-app-text-secondary">
              <X size={18} aria-hidden="true" />
            </button>
          </div>
          <div className="flex justify-center pb-2">{freshness}</div>
        </>
      ) : (
        <div className={`flex items-center gap-2 ${pad} pb-1.5 pt-2.5`}>
          <span className="flex-1 text-compact font-semibold text-app-text">{tr('hubContext.open')}</span>
          {freshness}
        </div>
      )}

      {down && (
        <div data-testid="context-hub-down" className={`flex items-center gap-2 ${pad} py-1.5 text-mini ${WARNING_TEXT}`}>
          <CloudOff size={12} className="flex-none" aria-hidden="true" />
          <span className="flex-1">{doc.okAt !== null ? tr('hubContext.hubDownSince', { time: clock.time(doc.okAt) }) : tr('hubContext.hubDown')}</span>
          <button type="button" className="text-primary hover:underline" onClick={() => { void reread(); }}>{tr('hubContext.retry')}</button>
        </div>
      )}
      {!view && !down && <div className={`${pad} py-3 text-mini text-app-text-secondary`}>{tr('hubContext.reading')}</div>}
      {!view && down && <div className={`${pad} py-3 text-mini text-app-text-secondary`}>{tr('hubContext.empty')}</div>}

      {view && (
        <div className="min-h-0 flex-1 pb-2">
          <p data-testid="context-lead" className={`m-0 ${pad} pb-1 text-mini text-app-text-muted`}>{tr('hubContext.lead')}</p>
          <Weights view={view} tr={tr} locale={locale} pad={pad} />
          <Contradictions
            view={view}
            tr={tr}
            pad={pad}
            isMobile={isMobile}
            when={(at) => clock.when(tr, at)}
            running={running}
            asking={asking}
            starting={starting}
            refused={refused}
            hubDown={down}
            onAsk={() => { setRefused(null); setAsking(true); }}
            onCancel={() => setAsking(false)}
            onStart={() => { void start(); }}
          />
          <Files view={view} tr={tr} locale={locale} pad={pad} isMobile={isMobile} now={doc.okAt ?? Date.now()} />
          <Duplicates view={view} tr={tr} pad={pad} />
          <OldRules view={view} tr={tr} pad={pad} />
          {view.doctor && <Doctor doctor={view.doctor} tr={tr} pad={pad} />}
        </div>
      )}
    </div>
  );
}

function Weights({ view, tr, locale, pad }: { view: ContextView; tr: Tr; locale: string; pad: string }) {
  if (view.harnesses.length === 0) return null;
  const max = Math.max(...view.harnesses.map((h) => h.tokens));
  return (
    <div data-testid="context-weights" className={`${pad} mt-0.5`}>
      <div className={SECTION}><Scale size={12} aria-hidden="true" />{tr('hubContext.weight')}<span className={SECTION_HINT}>{tr('hubContext.weight.hint')}</span></div>
      {view.harnesses.map((h) => (
        <div key={h.name} data-testid="context-harness" className="py-1">
          <div className="flex items-center gap-2 text-compact">
            <span className="w-[104px] flex-none truncate text-app-text" title={h.name}>{h.name}</span>
            <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-app-border">
              <span className="block h-full rounded-full bg-primary/70" style={{ width: `${Math.max(4, Math.round((h.tokens / max) * 100))}%` }} />
            </span>
            <span className="w-[56px] flex-none text-right text-mini tabular-nums text-app-text-secondary">{tr('hubContext.tok', { n: shortTokens(h.tokens, locale) })}</span>
          </div>
          {h.extra && (
            <div className="ml-[112px] text-mini text-app-text-muted">
              {tr(h.extra.home ? 'hubContext.weight.home' : 'hubContext.weight.some', { n: shortTokens(h.extra.tokens, locale) })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

interface ContradictionsProps {
  view: ContextView;
  tr: Tr;
  pad: string;
  isMobile: boolean;
  when: (at: number) => string;
  running: boolean;
  asking: boolean;
  starting: boolean;
  refused: string | null;
  hubDown: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onStart: () => void;
}

function Contradictions({ view, tr, pad, isMobile, when, running, asking, starting, refused, hubDown, onAsk, onCancel, onStart }: ContradictionsProps) {
  const { check } = view;
  const button = `inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-2.5 font-medium ${isMobile ? 'h-9 text-body' : 'h-6 text-mini coarse:h-11'}`;
  return (
    <div data-testid="context-contradictions" className={`${pad} mt-2`}>
      <div className={`${SECTION} ${check.items.length > 0 ? WARNING_TEXT : ''}`}>
        <AlertTriangle size={12} aria-hidden="true" />{tr('hubContext.contradictions')}
        <span className="font-normal tabular-nums">{check.items.length}</span>
        {check.at !== null && <span className={SECTION_HINT}>{tr('hubContext.check.at', { when: when(check.at) })}</span>}
      </div>
      {check.items.length === 0 && !running && (
        <p className="m-0 py-1 text-mini text-app-text-secondary">{tr(check.at === null ? 'hubContext.check.never' : 'hubContext.check.none')}</p>
      )}
      {check.items.map((c, i) => (
        <div key={i} data-testid="context-contradiction" className="mb-1.5 rounded border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-2">
          <div className={`text-app-text ${isMobile ? 'text-body' : 'text-compact'}`}>{c.why}</div>
          <div className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-mini">
            <span className="text-app-text-muted">{c.a.where}</span><RuleText text={c.a.text} className="text-app-text-secondary" />
            <span className="text-app-text-muted">{c.b.where}</span><RuleText text={c.b.text} className="text-app-text-secondary" />
          </div>
        </div>
      ))}
      {check.error && !running && <p className={`m-0 py-1 text-mini ${DANGER_TEXT}`}>{tr('hubContext.check.lastFailed', { why: check.error })}</p>}
      {running ? (
        <div data-testid="context-check-running" className="flex items-center gap-2 py-1.5 text-compact text-app-text">
          <Loader2 size={13} className="flex-none animate-spin text-primary" aria-hidden="true" />
          <span className="min-w-0 flex-1">{tr('hubContext.check.running')}<span className="block text-mini text-app-text-muted">{tr('hubContext.check.runningHint')}</span></span>
        </div>
      ) : asking ? (
        <div data-testid="context-check-confirm" role="group" aria-label={tr('hubContext.check.go')} className="mt-1 rounded border border-app-border bg-app-inset px-2.5 py-2">
          <p className={`m-0 text-app-text ${isMobile ? 'text-body' : 'text-compact'}`}>{tr('hubContext.check.confirm')}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" data-testid="context-check-start" disabled={starting} onClick={onStart} className={`${button} bg-primary text-white hover:bg-primary/90 disabled:opacity-60`}>
              {starting ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Sparkles size={12} aria-hidden="true" />}{tr('hubContext.check.start')}
            </button>
            <button type="button" data-testid="context-check-cancel" onClick={onCancel} className={`${button} border border-app-border text-app-text-secondary hover:bg-app-hover`}>{tr('hubContext.check.cancel')}</button>
          </div>
          {refused && <p data-testid="context-check-refused" className={`m-0 mt-1.5 text-mini ${DANGER_TEXT}`}>{tr('hubContext.check.failed', { why: refused })}</p>}
        </div>
      ) : (
        <button
          type="button"
          data-testid="context-check-ask"
          disabled={hubDown}
          onClick={onAsk}
          className={`${button} mt-0.5 border border-app-border text-app-text hover:bg-app-hover disabled:opacity-50`}
        >
          <Sparkles size={12} aria-hidden="true" />{tr(check.at === null ? 'hubContext.check.go' : 'hubContext.check.again')}
        </button>
      )}
    </div>
  );
}

function Duplicates({ view, tr, pad }: { view: ContextView; tr: Tr; pad: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? view.duplicates : view.duplicates.slice(0, RULES_SHOWN);
  return (
    <div data-testid="context-duplicates" className={`${pad} mt-2`}>
      <div className={SECTION}>{tr('hubContext.duplicates')}<span className="font-normal tabular-nums">{view.duplicates.length}</span><span className={SECTION_HINT}>{tr('hubContext.duplicates.hint')}</span></div>
      {view.duplicates.length === 0 && <p className="m-0 py-1 text-mini text-app-text-secondary">{tr('hubContext.duplicates.none')}</p>}
      {shown.map((d, i) => (
        <div key={i} data-testid="context-duplicate" className="py-1">
          <RuleText text={d.text} className="text-compact text-app-text" />
          <span className="block truncate text-mini text-app-text-secondary">{d.where.join(' · ')}</span>
        </div>
      ))}
      <More count={view.duplicates.length - shown.length} all={all} total={view.duplicates.length} tr={tr} onToggle={() => setAll((v) => !v)} />
    </div>
  );
}

function OldRules({ view, tr, pad }: { view: ContextView; tr: Tr; pad: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? view.oldRules : view.oldRules.slice(0, RULES_SHOWN);
  return (
    <div data-testid="context-old-rules" className={`${pad} mt-2`}>
      <div className={SECTION}>{tr('hubContext.oldRules')}<span className="font-normal tabular-nums">{view.oldRules.length}</span><span className={SECTION_HINT}>{tr('hubContext.oldRules.hint')}</span></div>
      {view.oldRules.length === 0 && (
        <p data-testid="context-old-rules-none" className={`m-0 flex items-center gap-1.5 py-1 text-mini ${SUCCESS_TEXT}`}><Check size={12} aria-hidden="true" />{tr('hubContext.oldRules.none')}</p>
      )}
      {shown.map((r, i) => (
        <div key={i} data-testid="context-old-rule" className="py-1">
          <RuleText text={r.text} className="text-compact text-app-text" />
          <span className="block truncate text-mini text-app-text-secondary">{r.line !== null ? tr('hubContext.oldRules.metaLine', { where: r.where, line: r.line, days: r.days }) : tr('hubContext.oldRules.meta', { where: r.where, days: r.days })}</span>
        </div>
      ))}
      <More count={view.oldRules.length - shown.length} all={all} total={view.oldRules.length} tr={tr} onToggle={() => setAll((v) => !v)} />
    </div>
  );
}

/**
 * The verdict of agents-doctor: grey with a spinner while the hub still runs
 * it, green only when the hub says ok with nothing failing, red otherwise,
 * with the doctor's own error when it never finished (a timeout).
 */
function Doctor({ doctor, tr, pad }: { doctor: DoctorVerdict; tr: Tr; pad: string }) {
  const failedN = doctor.failing.length;
  return (
    <div data-testid="context-doctor" data-state={doctor.state} className={`${pad} mt-2 border-t border-app-border pt-2 text-mini text-app-text-secondary`}>
      {doctor.state === 'pending' ? (
        <span className="flex items-center gap-1.5">
          <Loader2 size={12} className="flex-none animate-spin" aria-hidden="true" />
          <span className="font-semibold text-app-text">{tr('hubContext.doctor.pending')}</span>
          <span className="truncate text-app-text-muted">{tr('hubContext.doctor.pendingHint')}</span>
        </span>
      ) : doctor.state === 'ok' ? (
        <span className={`flex items-center gap-1.5 ${SUCCESS_TEXT}`}><Check size={12} className="flex-none" aria-hidden="true" />{tr('hubContext.doctor.ok', { n: doctor.total })}</span>
      ) : (
        <>
          <span className={`flex items-center gap-1.5 font-semibold ${DANGER_TEXT}`}>
            <AlertTriangle size={12} aria-hidden="true" />{tr('hubContext.doctor.fail')}
            <span className="ml-auto flex items-center gap-1 font-normal text-app-text-muted"><Stethoscope size={11} aria-hidden="true" />
              {doctor.error ? tr('hubContext.doctor.errored') : tr('hubContext.doctor.counts', { n: doctor.total, failed: failedN })}
            </span>
          </span>
          {doctor.error && <span data-testid="context-doctor-error" className="mt-0.5 block text-app-text">{doctor.error}</span>}
          {doctor.failing.map((f) => <span key={f} className="mt-0.5 block text-app-text">{f}</span>)}
          {!doctor.error && failedN === 0 && <span className="mt-0.5 block text-app-text">{tr('hubContext.doctor.notOk')}</span>}
        </>
      )}
    </div>
  );
}

/**
 * A rule's text: one line while closed, the whole of it on a tap. The rules
 * are what Attilio judges here, and a tooltip does not exist on the phone. The
 * chevron shows only when the line is actually cut.
 */
function RuleText({ text, className }: { text: string; className: string }) {
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setCut(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, text]);
  const canOpen = cut || open;
  return (
    <button
      type="button"
      data-testid="context-rule-text"
      aria-expanded={canOpen ? open : undefined}
      disabled={!canOpen}
      onClick={() => setOpen((v) => !v)}
      className={`flex w-full min-w-0 items-start gap-1 text-left disabled:cursor-default ${canOpen ? 'cursor-pointer' : ''} ${className}`}
    >
      <span ref={ref} className={`min-w-0 flex-1 ${open ? 'whitespace-pre-line break-words' : 'truncate'}`}>{text}</span>
      {canOpen && <ChevronDown size={12} className={`mt-0.5 flex-none text-app-text-muted ${open ? 'rotate-180' : ''}`} aria-hidden="true" />}
    </button>
  );
}

function More({ count, all, total, tr, onToggle }: { count: number; all: boolean; total: number; tr: Tr; onToggle: () => void }) {
  if (!all && count <= 0) return null;
  if (all && total <= RULES_SHOWN) return null;
  return (
    <button type="button" onClick={onToggle} className="flex w-full items-center gap-1.5 py-1 text-mini text-app-text-secondary hover:text-app-text">
      <ChevronDown size={12} className={all ? 'rotate-180' : ''} aria-hidden="true" />{all ? tr('hubContext.less') : tr('hubContext.more', { n: count })}
    </button>
  );
}
