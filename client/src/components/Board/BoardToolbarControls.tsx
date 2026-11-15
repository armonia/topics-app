import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Target, UploadCloud } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { Menu } from '../Shared/Menu';
import { boardApi, type BoardTask, type PublishProject, type DiffBundle } from '../../lib/board';
import { useGlobalDispatchCap } from '../../state/globalDispatchCap';
import { loadAdvice } from './dispatchLoad';
import { MachineBusyLine } from '../Shared/MachineBusyLine';
import { UnifiedDiff } from './UnifiedDiff';
import { useConfirm } from '../../hooks/useConfirm';
import { PRIORITY_DOT, TOOLBAR_CONTROL_H } from './constants';
import { POPOVER_ITEM } from '@/lib/popoverStyles';
import { MISSIONS, type Mission } from '../../lib/missions';

/**
 * DELIVERY, IN A SINGLE CONTROL.
 *
 * It used to be two adjacent buttons: "N not on main" (red) and "Publish M"
 * (amber). Two big numbers, two alarm colors, the same implicit sentence
 * ("there is work that has not yet arrived where it should") and neither
 * saying how it differs from the other. "14 not on main looks the same as
 * Publish to me" (a team member, 13/08): read from outside they were the same alarm
 * written twice.
 *
 * They are in fact the TWO RUNGS of the same ladder, and now they live in the
 * same panel, in this order:
 *
 *   1. NOT ON MAIN - closed tasks whose delivery is not recorded as merged. The
 *      work exists on a branch and nobody is looking at it. The task is opened
 *      to land it, or to find out why that work is not there.
 *   2. ON MAIN, NOT PUBLISHED - commits that main has and `origin` does not.
 *      Here the work is there, only the push is missing (and the deploy where
 *      one is configured).
 *
 * The button carries the two numbers with two different glyphs, not two bare
 * pills: the triangle is a problem to look at, the cloud is an action to take.
 * And it ALWAYS stays in the bar, even at zero, because "Publish" is also the
 * place you go to check that there is nothing to publish.
 */
/**
 * The publish failures the server names with a `code`, in the reader's
 * language. The server sentence is English and stays as the fallback: a code
 * this table does not know still reaches the reader as a sentence, not as a
 * silence.
 */
const PUBLISH_ERROR_KEY: Record<string, string> = {
  not_found: 'board.publish.notFound',
  detached_head: 'board.publish.detachedHead',
};

export function DeliveryControl({ unlanded, onOpen }: { unlanded: BoardTask[]; onOpen: (id: string) => void }) {
  const tr = useT();
  const [projects, setProjects] = useState<PublishProject[] | null>(null);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, DiffBundle | 'loading' | 'error'>>({});
  const btnRef = useRef<HTMLButtonElement>(null);
  const confirm = useConfirm();
  const refresh = useCallback(() => {
    boardApi.publishStatus().then(setProjects).catch(() => setProjects([]));
  }, []);
  const readDiff = (projectId: string) => {
    boardApi.publishDiff(projectId)
      .then((b) => setDiffs((d) => ({ ...d, [projectId]: b })))
      .catch(() => setDiffs((d) => ({ ...d, [projectId]: 'error' })));
  };
  const toggleExpand = (projectId: string, isOpen: boolean) => {
    if (isOpen) { setExpanded(null); return; }
    setExpanded(projectId);
    // Lazy-load the diff once per project when it's first opened.
    if (!diffs[projectId]) {
      setDiffs((d) => ({ ...d, [projectId]: 'loading' }));
      readDiff(projectId);
    }
  };
  useEffect(() => { refresh(); }, [refresh]);
  const pending = (projects ?? []).filter((p) => p.ahead > 0);
  const total = pending.reduce((n, p) => n + p.ahead, 0);
  const doPublish = async (p: PublishProject) => {
    // Show the exact commits in the confirm so a wrong-project / un-approved
    // commit is caught before the push - a push ships the WHOLE branch tip.
    const shown = p.commits.slice(0, 8);
    const more = p.commits.length > 8 ? p.commits.length - 8 : 0;
    const ok = await confirm({
      title: tr('board.publish.confirmTitle', { name: p.name }),
      confirmLabel: tr('board.publish.confirmLabel', { n: p.ahead }),
      body: (
        <div className="space-y-2">
          <p>{tr('board.publish.confirmBodyStart', { n: p.ahead })}<span className="font-mono">origin/{p.branch}</span>{tr('board.publish.confirmBodyEnd')}</p>
          <ul className="max-h-48 overflow-y-auto space-y-0.5 font-mono text-mini">
            {shown.map((c) => (
              <li key={c.hash} className="truncate">• {c.subject} ({c.hash}, {c.author})</li>
            ))}
          </ul>
          {more > 0 && <p className="text-app-text-secondary">{tr('board.publish.andMore', { n: more })}</p>}
        </div>
      ),
    });
    if (!ok) return;
    setBusy(p.projectId); setMsg(null);
    try {
      const r = await boardApi.publish(p.projectId);
      const key = r.code ? PUBLISH_ERROR_KEY[r.code] : undefined;
      const why = key ? tr(key) : r.error ?? tr('board.publish.error');
      setMsg(r.ok ? tr('board.publish.done', { name: p.name }) : `${p.name}: ${why}`);
      refresh();
    } catch (e) { setMsg(`${p.name}: ${(e as Error).message}`); }
    finally { setBusy(null); }
  };
  // The button's tone follows the most serious rung that has something to say:
  // work that is not on main is a problem (rose), a commit to publish is a
  // ready action (amber), neither of the two is rest (neutral).
  const tone = unlanded.length > 0
    ? 'bg-rose-500/15 text-rose-300 hover:bg-rose-500/25'
    : total > 0
      ? 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/25'
      : 'bg-white/10 text-app-text-secondary hover:bg-white/15';
  const title = [
    unlanded.length > 0 ? tr('board.delivery.unlandedTitle', { n: unlanded.length }) : null,
    total > 0 ? tr('board.delivery.toPublishTitle', { n: total }) : tr('board.delivery.nothingTitle'),
  ].filter(Boolean).join(' · ');
  return (
    <>
      <button
        ref={btnRef}
        data-testid="delivery-badge"
        onClick={() => { setOpen((s) => !s); refresh(); }}
        title={title}
        /* The row's one height (`TOOLBAR_CONTROL_H`), not a literal of its own. */
        className={`flex ${TOOLBAR_CONTROL_H} items-center gap-1.5 rounded px-2 text-mini transition-colors ${tone}`}
      >
        <span>{tr('board.toolbar.delivery')}</span>
        {unlanded.length > 0 && (
          <span data-testid="delivery-unlanded-count" className="flex items-center gap-0.5 rounded bg-rose-500/25 px-1 font-medium tabular-nums text-rose-200">
            <AlertTriangle className="h-3 w-3 shrink-0" />{unlanded.length}
          </span>
        )}
        {total > 0 && (
          <span data-testid="delivery-publish-count" className="flex items-center gap-0.5 rounded bg-amber-500/25 px-1 font-medium tabular-nums text-amber-200">
            <UploadCloud className="h-3 w-3 shrink-0" />{total}
          </span>
        )}
      </button>
      <Menu open={open} anchorRef={btnRef} onClose={() => setOpen(false)} align="right" minWidth={384} className="max-h-[70vh] w-96 overflow-y-auto" unmanagedFocus>
          {/* RUNG 1 - the work that has not even reached main. It sits on top
              because it is the only one of the two that signals a FAULT: a
              closed task whose work shows up nowhere. */}
          {unlanded.length > 0 && (
            <div className="border-b border-app-border pb-1">
              <div className="px-3 pb-1 pt-2 text-mini font-semibold uppercase tracking-wide text-rose-300/90">
                {tr('board.unlanded.title')}
              </div>
              {unlanded.map((t) => (
                <button
                  key={t.id}
                  data-testid="unlanded-item"
                  onClick={() => { setOpen(false); onOpen(t.id); }}
                  className={`${POPOVER_ITEM} !items-start`}
                >
                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[t.priority] ?? PRIORITY_DOT[2]}`} />
                  <span className="min-w-0 flex-1 truncate text-left">{t.text}</span>
                </button>
              ))}
              <p className="px-3 pb-1 pt-1 text-mini leading-snug text-app-text-muted">
                {tr('board.unlanded.blurb')}
              </p>
            </div>
          )}
          {/* RUNG 2 - on main, but not yet out. */}
          <div className="px-3 pb-1 pt-2 text-mini font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.publish.toPublish')}</div>
          {/* WHAT HAPPENS AFTER THE PUSH, said BEFORE the click and not in a
              tooltip: on this repo main is shipped, so "Publish" is not a
              save - it ships a release that reaches the auto-updater of
              anyone who has Topics open. Whoever presses is deciding on a
              publication, and no screen named it: it only said which commits
              would go out.
              It only appears when there is something to publish: on an empty
              list it would be a warning about a gesture nobody is about to make. */}
          {pending.length > 0 && (
            <p
              data-testid="publish-consequence"
              title={tr('board.publish.consequenceTitle')}
              /* amber-300/80 on a light theme measured 1.24:1 on the pixels:
                 a warning that cannot be read is not a warning. Same tuning
                 as the status bar signals (amber-800 light / amber-400
                 dark, 6.04 and 11.52), which already paid for it once. */
              className="px-3 pb-1 text-mini leading-snug text-amber-800 dark:text-amber-400"
            >
              {tr('board.publish.consequence')}
            </p>
          )}
          <div className="p-1 pt-0">
            {pending.length === 0 ? (
              <div className="px-2 py-1.5 text-mini text-app-text-muted">{tr('board.publish.nothing')}</div>
            ) : pending.map((p) => {
              const isOpen = expanded === p.projectId;
              return (
                <div key={p.projectId} className="rounded">
                  <div className="flex items-center gap-1.5 px-1 py-1 hover:bg-white/5">
                    <button
                      onClick={() => toggleExpand(p.projectId, isOpen)}
                      className="flex min-w-0 flex-1 items-center gap-1 text-left"
                      title={isOpen ? tr('board.unlanded.hide') : tr('board.unlanded.show')}
                    >
                      {isOpen ? <ChevronDown className="h-3 w-3 shrink-0 text-app-text-muted" /> : <ChevronRight className="h-3 w-3 shrink-0 text-app-text-muted" />}
                      <span className="min-w-0 flex-1 truncate text-compact text-app-text">{p.name}<span className="ml-1 text-mini text-app-text-muted">{p.ahead} commit · {p.branch}</span></span>
                    </button>
                    <button disabled={busy === p.projectId} onClick={() => doPublish(p)} className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-mini text-amber-200 hover:bg-amber-500/30 disabled:opacity-50">{busy === p.projectId ? '…' : 'Pubblica'}</button>
                  </div>
                  {isOpen && (
                    <ul className="mb-1 ml-4 space-y-0.5 border-l border-app-border pl-2">
                      {p.commits.map((c) => (
                        <li key={c.hash} className="flex items-baseline gap-1.5 text-mini leading-tight">
                          <code className="shrink-0 text-app-text-muted">{c.hash}</code>
                          <span className="min-w-0 flex-1 truncate text-app-text-heading" title={c.subject}>{c.subject}</span>
                          <span className="shrink-0 text-app-text-faint">{c.author} · {c.when}</span>
                        </li>
                      ))}
                      {p.commits.length >= 50 && <li className="text-mini text-app-text-faint">{tr('board.publish.truncated')}</li>}
                    </ul>
                  )}
                  {isOpen && (
                    <div className="mb-1.5 ml-4 border-l border-app-border pl-2">
                      <div className="mb-0.5 text-mini uppercase tracking-wide text-app-text-faint">{tr('board.publish.diffTitle')}</div>
                      {diffs[p.projectId] === 'loading' && <div className="text-mini text-app-text-muted">{tr('board.publish.loadingDiff')}</div>}
                      {diffs[p.projectId] === 'error' && <div className="text-mini text-red-400">{tr('board.publish.diffError')}</div>}
                      {diffs[p.projectId] && typeof diffs[p.projectId] === 'object' && (
                        <UnifiedDiff
                          bundle={diffs[p.projectId] as DiffBundle}
                          source={{ kind: 'publish', projectId: p.projectId }}
                          onStale={() => readDiff(p.projectId)}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {msg && <div className="mt-0.5 border-t border-app-border px-2 py-1.5 text-mini text-app-text-secondary">{msg}</div>}
          </div>
      </Menu>
    </>
  );
}

/**
 * THE WORKING FOLDERS - the number that only said itself.
 *
 * It was a `<span>` holding "7 worktree" with the explanation in the `title`: a
 * bare number in a bar does not say what it is about, and "worktree" is a word
 * the person looking at the board has no reason to know. Here it becomes a
 * command: the label says the thing in Italian, and the click opens the one
 * place that answers the two real questions - what they are, and how to free
 * them.
 *
 * The GC ("Pulisci landati") with its result lives inside too; before, they
 * were two extra elements IN THE BAR, always present, for an action taken once
 * in a while. The bar gains the space, and the explanation gains the right
 * place: next to the button that puts it into practice.
 *
 * The two piles stay TWO distinct numbers, and that is the point: a landed
 * branch frees its folder, but a folder kept because the task is still open
 * has no branch to land. With a single number you cannot tell which of the
 * two is growing - and it grew silently up to ~40 folders on 21/07.
 */
export function WorktreeControl({ count, branches, gcRunning, gcResult, onGc }: {
  count: number;
  branches: { total: number; orphan: number; onOpenTasks: number } | null;
  gcRunning: boolean;
  gcResult: string | null;
  onGc: () => void;
}) {
  const tr = useT();
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  const orphan = branches?.orphan ?? 0;
  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        data-testid="worktree-count-badge"
        className={`flex ${TOOLBAR_CONTROL_H} items-center gap-1 rounded px-2 text-mini ${orphan > 0
          ? 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/25'
          : 'bg-white/10 text-app-text-secondary hover:bg-white/20'}`}
      >{tr('board.worktree.count', { n: count })}{orphan > 0 && <span className="tabular-nums">{tr('board.worktree.orphanBranches', { n: orphan })}</span>}</button>
      <Menu open={open} anchorRef={btnRef} onClose={() => setOpen(false)} minWidth={320}>
        <div className="space-y-1.5 px-3 py-2.5 text-mini leading-snug text-app-text-secondary">
          <p className="text-compact font-medium text-app-text-heading">{tr('board.worktree.countOpen', { n: count })}</p>
          <p>{tr('board.worktree.whatStart')}<span className="font-mono">git worktree</span>{tr('board.worktree.whatEnd')}</p>
          {branches && branches.total > 0 && (
            <p data-testid="worktree-branches-line">
              {tr('board.worktree.branchesStart')}<span className="text-app-text-heading">{tr('board.worktree.branchesCount', { n: branches.total })}</span>{tr('board.worktree.branchesMid')}
              {branches.orphan > 0 && <> <span className="text-amber-300">{branches.orphan}</span>{tr('board.worktree.branchesOrphan')}</>}
              {branches.onOpenTasks > 0 && <>{tr('board.worktree.branchesOpen', { n: branches.onOpenTasks })}</>}
            </p>
          )}
          <p className="text-app-text-muted">{tr('board.worktree.twoPiles')}</p>
        </div>
        <div className="flex items-center gap-2 border-t border-app-border px-3 py-2">
          <button
            onClick={onGc}
            disabled={gcRunning}
            className="shrink-0 rounded bg-white/10 px-2 py-1 text-mini text-app-text-secondary hover:bg-white/20 disabled:opacity-50"
            data-testid="worktree-gc-button"
          >{tr(gcRunning ? 'board.worktree.gcRunning' : 'board.worktree.gc')}</button>
          <span className="text-mini leading-snug text-app-text-muted">
            {tr('board.worktree.gcHint')}
          </span>
        </div>
        {gcResult && (
          <p className="border-t border-app-border px-3 py-1.5 text-mini leading-snug text-app-text-secondary" data-testid="worktree-gc-result">{gcResult}</p>
        )}
      </Menu>
    </>
  );
}

/**
 * THE LOAD, SAID AS A SENTENCE.
 *
 * The previous version said "Critical load Â· max 1", and neither half
 * explained itself: "critical load" is a fact about the machine that asks
 * nothing of the reader, and "max 1" looks like an imposed LIMIT when it is
 * ADVICE - two very different things for someone reading them in a bar. The
 * explanation existed, but it sat in the `title`: on a phone it does not
 * exist, and with a mouse it has to be hunted for. A tooltip is not an
 * explanation.
 *
 * So two rules:
 *
 * 1. **It appears only when there is something to do.** The chip lives on the
 *    GAP between the agents that are running (`running`, from the dispatcher)
 *    and the ones the machine can sustain right now (`recommended`). Gap <= 0
 *    means no chip, even with the machine on its knees: if there is nothing
 *    to stop, an alarm is just noise. It is also why `running` was added to
 *    the capacity: without it, "max N" could not know whether there was a gap.
 * 2. **What you see is already the action, in two words.** "Stop 2", not an
 *    adjective and not a sentence. The bar is a row of controls, not a place
 *    to read: "Machine loaded: better stop 2 agents" was thirty-eight
 *    characters that pushed the project filters out, and the part that
 *    mattered was the number. The verb stays because a number alone does not
 *    say what to do with it. The detail (CPU, cores, why) lives in the
 *    popover, openable with a finger, which also says it is advice and not a
 *    cap.
 *
 * The probe (every 15s) is the one of the global cap store, not a second one
 * per chip: the same read serves the chip, the title menu and the settings
 * panel.
 */
export function LoadAdviceChip() {
  const tr = useT();
  const store = useGlobalDispatchCap();
  const cap = store.capacity;
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // Nothing to stop, or the brake by resources, where the count does not apply:
  // there the advice drew "stop 12" while the gate was admitting
  // (`loadAdvice`, which also holds the severity rule).
  const advice = loadAdvice(store);
  if (!cap || !advice) return null;
  const { over, severe } = advice;
  const cls = severe
    ? 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30 hover:bg-rose-500/25'
    : 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30 hover:bg-amber-500/25';
  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        data-testid="load-advice-chip"
        className={`flex ${TOOLBAR_CONTROL_H} items-center gap-1 rounded px-2 text-mini font-medium ${cls}`}
      >
        <AlertTriangle className="h-3 w-3 shrink-0" />
        {tr('board.load.stopN', { n: over })}
      </button>
      <Menu open={open} anchorRef={btnRef} onClose={() => setOpen(false)} minWidth={288}>
        <div className="space-y-1.5 px-3 py-2.5 text-mini leading-snug text-app-text-secondary">
          <p className="text-compact font-medium text-app-text-heading">
            {tr('board.load.headline', { running: cap.running ?? 0, recommended: cap.recommended })}
          </p>
          {/* How busy the Mac is, in the one number every load surface says.
              The server's own derivation ("12 core -> base 4 ...") is true and
              technical: it waits under "Details" for whoever asks. */}
          <MachineBusyLine shares={cap} />
          <p>{tr('board.load.advice')}</p>
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-mini text-app-text-muted hover:text-app-text-secondary">
              <ChevronRight size={10} className="transition-transform group-open:rotate-90" aria-hidden="true" />
              {tr('board.gauge.details')}
            </summary>
            <p className="mt-1 text-app-text-muted">{cap.reason}</p>
          </details>
        </div>
      </Menu>
    </>
  );
}

/**
 * MISSIONS - the only command the board has toward the side session.
 *
 * Three things, all deliberate:
 *
 * 1. **It is not a surface on the board.** It is a button that opens a menu and
 *    hands the text to a NORMAL project chat, the one that already exists. The
 *    previous version (5f39a2c1) did the opposite - a chip inside the
 *    composer, that is inside the point every card is born from, which changed
 *    the meaning of the whole row - and it is the reason it was rejected.
 * 2. **Outside development it does not exist** (`useDevInstall`): not hidden,
 *    not disabled, not rendered. Whoever uses Topics to work must not find a
 *    governing panel for their board.
 * 3. **The bar is read BEFORE choosing** (`doneWhen` under each name): it is
 *    what tells a mission from a prompt, and putting it only inside the text
 *    would mean choosing it without knowing when it ends.
 */
export function MissionsMenu({ onStart }: { onStart: (m: Mission) => void }) {
  const tr = useT();
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        data-testid="missions-button"
        title={tr('board.toolbar.missionsTitle')}
        className={`flex ${TOOLBAR_CONTROL_H} items-center gap-1 rounded px-2 text-mini ${open ? 'bg-white/15 text-app-text' : 'text-app-text-secondary hover:bg-white/10'}`}
      ><Target className="h-3 w-3 shrink-0" /><span className="hidden sm:inline">{tr('board.toolbar.missions')}</span></button>
      <Menu open={open} anchorRef={btnRef} onClose={() => setOpen(false)} minWidth={330}>
        <div className="px-3 pb-1 pt-2 text-mini font-semibold uppercase tracking-wide text-app-text-muted">
          {tr('board.mission.toProject')}
        </div>
        {MISSIONS.map((m) => (
          <button
            key={m.id}
            data-testid={`mission-${m.id}`}
            onClick={() => { setOpen(false); onStart(m); }}
            className={`${POPOVER_ITEM} flex-col !items-start gap-0.5 py-1.5`}
          >
            <span className="font-medium text-app-text">{m.name}</span>
            <span className="text-mini leading-snug text-app-text-secondary">{m.summary}</span>
            <span className="text-mini leading-snug text-app-text-muted">{tr('board.mission.doneWhen', { what: m.doneWhen })}</span>
          </button>
        ))}
      </Menu>
    </>
  );
}
