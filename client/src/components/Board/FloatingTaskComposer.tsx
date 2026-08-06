import { useState, useEffect, useRef } from 'react';
import { Check, ChevronDown, ClipboardList, Loader2, Send, Sparkles } from 'lucide-react';
import { Menu } from '../Shared/Menu';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { boardApi, boardDrafts, AUTO_PROJECT_ID, UNASSIGNED_PROJECT_ID, type BoardProjectRef } from '../../lib/board';
import { addBoardProject, projectNameFromId, useBoardProjects, useNewProjectDir } from '../../lib/boardProjectsStore';
import { getProvidersSnapshotState, subscribeProvidersSnapshot } from '../../lib/providersSnapshotStore';
import { writeCursor, markActiveComposer, restoreCursor } from '../../lib/composerCursor';
import { CHIP_LABEL, COMPOSER_CURSOR_KEY, PRIORITY_DOT, PRIORITY_LABEL, PRIORITY_ORDER } from './constants';
import { autoGrow, friendlyModelLabel } from './format';
import { ProjectPickerBody } from './ProjectPicker';
import { POPOVER_ITEM } from '@/lib/popoverStyles';

/**
 * The "dai questo all'agent" entry point: a floating input at the bottom of
 * the board. Collapsed it's a slim pill; on focus it RISES slightly and
 * expands (plan-first toggle, project select in the global board, submit) —
 * and eases back on blur. The task is born in Todo (the dispatch signal);
 * title = first line, full text goes to the description, and the dispatched
 * agent polishes the wording (kickoff rule) — no model to pick, ever.
 */
export function FloatingTaskComposer({ projectId, global, onCreated, onError }: {
  projectId: string;
  /** Cross-project mode: no implicit board — the project picker chip appears. */
  global: boolean;
  onCreated: () => void;
  onError: (e: string) => void;
}) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [planFirst, setPlanFirst] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // L'indice dei progetti arriva dallo store CONDIVISO e parte al mount, non al
  // primo focus. Il chip mostra il `path` del progetto scelto — e senza `path`
  // non c'è icona: caricandolo pigramente, una bozza ripristinata (che espande
  // il composer senza alcun focus) lasciava il chip col pallino di ripiego per
  // sempre, mentre il drawer di dettaglio — che fetcha al mount — l'icona ce
  // l'aveva. Stesso progetto, due superfici, due risposte.
  const projects = useBoardProjects(global);
  const newProjectDir = useNewProjectDir(global);
  const [targetProject, setTargetProject] = useState<string>(() => {
    try {
      const stored = localStorage.getItem('board:composerProject');
      // '_none' is no longer a picker choice (auto falls back to it): migrate.
      return !stored || stored === UNASSIGNED_PROJECT_ID ? AUTO_PROJECT_ID : stored;
    } catch { return AUTO_PROJECT_ID; }
  });
  // Project picker — the SAME Menu-primitive selector the task-detail header
  // uses (portal, flip-above, keyboard nav), not a bare native <select>.
  const [projOpen, setProjOpen] = useState(false);
  const [projBusy, setProjBusy] = useState(false);
  const projBtnRef = useRef<HTMLButtonElement>(null);
  // Model picker — "Intelligenza automatica" (null) or a claude-code model.
  const [modelOpen, setModelOpen] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  // Priority — "Automatica" (null: the agent evaluates it at kickoff) or 0-4.
  const [prioOpen, setPrioOpen] = useState(false);
  const [prio, setPrio] = useState<number | null>(null);
  const prioBtnRef = useRef<HTMLButtonElement>(null);
  // Keyboard-aware lift (mobile): the software keyboard overlays the bottom of
  // the layout viewport, so an `absolute bottom-6` composer ends up hidden behind
  // it. Track visualViewport and translate the composer up by the overlapping
  // height so the input stays visible while typing. No-op on desktop (overlap 0).
  const [kbInset, setKbInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const overlap = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
      setKbInset(overlap > 80 ? overlap : 0); // ignore browser-chrome deltas
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); };
  }, []);
  // Server-persisted draft: a half-written task survives reload/app restart
  // and follows the user across clients. Restored once; local typing wins.
  const draftLoaded = useRef(false);
  useEffect(() => {
    let alive = true;
    boardDrafts.getComposer().then((d) => {
      if (!alive) return;
      if (d) {
        setText((cur) => cur || d.text || '');
        setModel((cur) => cur ?? d.model ?? null);
        setPrio((cur) => cur ?? d.prio ?? null);
        if (d.planFirst) setPlanFirst(true);
      }
      draftLoaded.current = true;
      // Restore the caret one frame after the draft text commits into the
      // textarea, so a hot reload lands you exactly where you were typing.
      requestAnimationFrame(() => restoreCursor(COMPOSER_CURSOR_KEY, taRef.current));
    }).catch(() => { draftLoaded.current = true; });
    return () => { alive = false; };
  }, []); // restore-once on mount
  useEffect(() => {
    if (!draftLoaded.current) return; // never clobber the server draft pre-restore
    boardDrafts.putComposer({ text, model, prio, planFirst });
  }, [text, model, prio, planFirst]);
  const [claudeModels, setClaudeModels] = useState<string[]>(
    () => getProvidersSnapshotState().snapshot?.providers.find((p) => p.name === 'claude-code')?.models ?? [],
  );
  const modelsSubRef = useRef<(() => void) | null>(null);
  const loadModels = () => {
    if (modelsSubRef.current) return;
    modelsSubRef.current = subscribeProvidersSnapshot((state) => {
      setClaudeModels(state.snapshot?.providers.find((p) => p.name === 'claude-code')?.models ?? []);
    });
  };
  useEffect(() => () => { modelsSubRef.current?.(); }, []);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const saveCursor = () => { const ta = taRef.current; if (ta) writeCursor(COMPOSER_CURSOR_KEY, ta.selectionStart, ta.selectionEnd); };
  const wrapRef = useRef<HTMLDivElement>(null);
  // Task composer hotkey listener (Cmd+Shift+;)
  useEffect(() => {
    const handleTaskComposerFocus = () => {
      setFocused(true);
      setTimeout(() => { taRef.current?.focus(); }, 0);
    };
    window.addEventListener('task-composer:focus', handleTaskComposerFocus);
    return () => window.removeEventListener('task-composer:focus', handleTaskComposerFocus);
  }, []);
  // The Menu portals to <body>, so focus leaves the wrapper while it's open —
  // keep the composer expanded anyway.
  const expanded = focused || projOpen || modelOpen || prioOpen || text.trim().length > 0;

  const onFocus = () => {
    setFocused(true);
    markActiveComposer(COMPOSER_CURSOR_KEY);
  };
  // Collapse only when focus truly LEFT the composer (not moving between its
  // own controls) — otherwise clicking "Plan first" would blur-shrink it.
  const onBlurCapture = (e: React.FocusEvent) => {
    if (projOpen || modelOpen) return;
    if (wrapRef.current && e.relatedTarget instanceof Node && wrapRef.current.contains(e.relatedTarget)) return;
    setFocused(false);
  };
  // WebKit: buttons do NOT take focus on click (relatedTarget = null), so the
  // blur check above can't recognise "still inside" and the pill collapsed
  // under the click (project chip, plan-first). Kill the focus steal at the
  // source: pointerdown on the composer's buttons keeps the textarea focused —
  // no blur, nothing to recover. Clicks still fire; the portaled Menu (and the
  // textarea itself) are untouched.
  const onPointerDownCapture = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) e.preventDefault();
  };

  const target = global ? targetProject : projectId;
  const noneTarget = targetProject === UNASSIGNED_PROJECT_ID;
  const autoTarget = targetProject === AUTO_PROJECT_ID;
  const targetRef = projects?.find((p) => p.projectId === targetProject) ?? null;
  // Readable before the index loads: the stored id minus its hash suffix.
  const targetLabel = autoTarget
    ? 'Progetto auto'
    : noneTarget
      ? 'Nessun progetto'
      : targetRef?.name ?? (targetProject ? projectNameFromId(targetProject) : '');

  const pickProject = (p: BoardProjectRef) => {
    setTargetProject(p.projectId);
    try { localStorage.setItem('board:composerProject', p.projectId); } catch { /* private mode */ }
    setProjOpen(false);
  };
  const pickSentinel = (id: string) => {
    setTargetProject(id);
    try { localStorage.setItem('board:composerProject', id); } catch { /* private mode */ }
    setProjOpen(false);
  };
  const doCreateProject = async (name: string) => {
    if (!name || projBusy) return;
    setProjBusy(true);
    try {
      const created = await boardApi.createProject(name);
      addBoardProject(created); // entra nell'indice per OGNI superficie, non solo qui
      pickProject(created);
    } catch (e) { onError(e instanceof Error ? e.message : 'create project failed'); }
    finally { setProjBusy(false); }
  };

  const submit = async () => {
    const raw = text.trim();
    if (!raw || submitting) return;
    if (!target) { onError('Scegli il progetto del task.'); setProjOpen(true); return; }
    const lines = raw.split('\n');
    const firstLine = lines[0].trim();
    const title = firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine;
    // Description = the text AFTER the first line — the drawer must not show
    // the title glued again right under itself. A truncated first line keeps
    // the full text so nothing is lost.
    const rest = lines.slice(1).join('\n').trim();
    const description = firstLine.length > 80 ? raw : rest || null;
    setSubmitting(true);
    try {
      await boardApi.create(target, { text: title, description, status: 'todo', planFirst, model: model ?? undefined, priority: prio ?? undefined });
      setText('');
      setPlanFirst(false);
      setModel(null);
      setPrio(null);
      boardDrafts.clearComposer();
      if (taRef.current) taRef.current.style.height = 'auto';
      onCreated();
    } catch (e) { onError(e instanceof Error ? e.message : 'create failed'); }
    finally { setSubmitting(false); }
  };

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-6 z-10 flex justify-center px-4 transition-transform duration-150 ease-out"
      style={kbInset ? { transform: `translateY(-${kbInset}px)` } : undefined}
    >
      <div
        ref={wrapRef}
        onFocusCapture={onFocus}
        onBlurCapture={onBlurCapture}
        onPointerDownCapture={onPointerDownCapture}
        data-testid="board-task-composer"
        // @container: la riga dei chip qui sotto si compatta sulla larghezza di
        // QUESTA card — cioè della pane — non del viewport. I breakpoint `sm:`
        // non scattano mai dentro una pane stretta su uno schermo largo, che è
        // il caso normale in un layout a riquadri. Stesso schema del composer
        // della chat (ChatInput.tsx).
        className={`input-glass @container pointer-events-auto w-full max-w-2xl rounded-2xl border shadow-2xl shadow-black/50 transition-all duration-200 ease-out ${
          expanded ? '-translate-y-2 border-app-border-light' : 'translate-y-0 border-app-border'
        }`}
      >
        <textarea
          value={text} rows={1}
          ref={(el) => { taRef.current = el; autoGrow(el); }}
          onChange={(e) => { setText(e.target.value); autoGrow(e.currentTarget); saveCursor(); }}
          onSelect={saveCursor}
          onKeyUp={saveCursor}
          onClick={saveCursor}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder="Descrivi un task per l'agent…"
          className={`block max-h-40 w-full resize-none overflow-y-auto bg-transparent px-3.5 py-3 text-sm leading-5 text-app-text outline-none transition-[min-height] duration-200 ease-out placeholder:text-app-placeholder ${
            expanded ? 'min-h-[4.5rem]' : 'min-h-0'
          }`}
        />
        <div className={`flex items-center gap-2 overflow-hidden px-2.5 transition-all duration-200 ease-out ${expanded ? 'max-h-12 pb-2 opacity-100' : 'max-h-0 pb-0 opacity-0'}`}>
          {/* Cluster dei chip: `min-w-0 flex-1` gli lascia stringersi sotto la
              larghezza del contenuto e `overflow-x-auto` lo fa SCORRERE invece
              di tagliare — prima la riga era un unico flex con `overflow-hidden`
              e chip `shrink-0`: sotto ~430px di card il bottone Invia finiva
              oltre il bordo e spariva, cioè il composer diventava inutilizzabile
              proprio dove serve di più (pane stretta, telefono). I figli restano
              `shrink-0` perché lo scroll funzioni davvero: senza, si
              schiaccerebbero sotto il minimo tattile invece di traboccare. */}
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto scrollbar-hide">
            {global && (
              <>
                <button
                  ref={projBtnRef}
                  onClick={() => setProjOpen(true)}
                  data-testid="composer-project-chip"
                  title={autoTarget
                    ? 'Progetto automatico: risolto dal testo del task (nome citato); se non è chiaro va nel progetto generale'
                    : targetLabel ? `Progetto: ${targetLabel}` : 'Scegli il progetto del task'}
                  // L'UNICO chip che può stringersi (l'etichetta è troncabile),
                  // con un pavimento: sotto ~5.5rem resterebbero icona e chevron
                  // senza una lettera di nome, che è peggio di far scorrere la riga.
                  className="flex min-w-[5.5rem] max-w-[13rem] items-center gap-1.5 rounded-md bg-black/5 px-2 py-1 text-xs text-app-text hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10"
                >
                  {autoTarget
                    ? <Sparkles className="h-3 w-3 shrink-0 text-app-text-muted" />
                    : <ProjectFavicon path={targetRef?.path ?? ''} size={13} fallback={<span className={`h-1.5 w-1.5 shrink-0 rounded-full ${targetProject && !noneTarget ? 'bg-emerald-400' : 'bg-app-text-faint'}`} />} />}
                  <span className="truncate">{targetLabel || 'Progetto…'}</span>
                  <ChevronDown className="h-3 w-3 shrink-0 text-app-text-muted" />
                </button>
                <Menu
                  open={projOpen}
                  anchorRef={projBtnRef}
                  onClose={() => setProjOpen(false)}
                  minWidth={230}
                  role="listbox"
                  unmanagedFocus
                >
                  <ProjectPickerBody
                    projects={projects}
                    selectedId={targetProject}
                    onPick={pickProject}
                    onCreate={doCreateProject}
                    busy={projBusy}
                    listLabel="Progetto del task"
                    onPickAuto={() => pickSentinel(AUTO_PROJECT_ID)}
                    autoSelected={autoTarget}
                    newProjectDir={newProjectDir}
                  />
                </Menu>
              </>
            )}
            <button
              ref={modelBtnRef}
              onClick={() => { setModelOpen(true); loadModels(); }}
              data-testid="composer-model-chip"
              title={model ? `Modello: ${friendlyModelLabel(model)}` : 'Modello: intelligenza automatica (sceglie il provider)'}
              className="flex shrink-0 items-center gap-1 rounded-md bg-black/5 px-2 py-1 text-[11px] text-app-text-heading hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10"
            ><Sparkles className="h-3 w-3 shrink-0 text-app-text-muted" /><span className={CHIP_LABEL}>{model ? friendlyModelLabel(model) : 'Modello auto'}</span><ChevronDown className="h-3 w-3 shrink-0 text-app-text-muted" /></button>
            <Menu open={modelOpen} anchorRef={modelBtnRef} onClose={() => setModelOpen(false)} minWidth={170} role="listbox">
              <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">Modello</p>
              <button
                role="option" aria-selected={model === null}
                onClick={() => { setModel(null); setModelOpen(false); }}
                title="Lascia scegliere il provider"
                className={POPOVER_ITEM}
              >
                <span className="min-w-0 flex-1">Intelligenza automatica</span>
                {model === null && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
              </button>
              {claudeModels.map((m) => (
                <button
                  key={m} role="option" aria-selected={model === m}
                  onClick={() => { setModel(m); setModelOpen(false); }}
                  className={POPOVER_ITEM}
                >
                  <span className="min-w-0 flex-1 truncate">{friendlyModelLabel(m)}</span>
                  {model === m && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                </button>
              ))}
            </Menu>
            <button
              ref={prioBtnRef}
              onClick={() => setPrioOpen(true)}
              data-testid="composer-priority-chip"
              title={prio !== null ? `Priorità: ${PRIORITY_LABEL[prio]}` : "Priorità automatica: la valuta l'agent appena inquadra il task"}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-black/5 px-2 py-1 text-[11px] text-app-text-heading hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10"
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${prio !== null ? PRIORITY_DOT[prio] : 'border border-app-text-faint'}`} />
              <span className={CHIP_LABEL}>{prio !== null ? PRIORITY_LABEL[prio] : 'Priorità auto'}</span>
              <ChevronDown className="h-3 w-3 shrink-0 text-app-text-muted" />
            </button>
            <Menu open={prioOpen} anchorRef={prioBtnRef} onClose={() => setPrioOpen(false)} minWidth={170} role="listbox">
              <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">Priorità</p>
              <button
                role="option" aria-selected={prio === null}
                onClick={() => { setPrio(null); setPrioOpen(false); }}
                title="La valuta l'agent al primo turno; la coda serve prima le priorità alte"
                className={POPOVER_ITEM}
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-app-text-faint" />
                <span className="min-w-0 flex-1">Automatica</span>
                {prio === null && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
              </button>
              {PRIORITY_ORDER.map((p) => (
                <button
                  key={p} role="option" aria-selected={prio === p}
                  onClick={() => { setPrio(p); setPrioOpen(false); }}
                  className={POPOVER_ITEM}
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[p]}`} />
                  <span className="min-w-0 flex-1">{PRIORITY_LABEL[p]}</span>
                  {prio === p && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                </button>
              ))}
            </Menu>
            <button
              onClick={() => setPlanFirst((v) => !v)}
              title="L'agent consegna prima un piano da approvare, implementa dopo il tuo ok"
              className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
                planFirst ? 'bg-violet-500/25 text-violet-200' : 'bg-black/5 text-app-text-secondary hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10'
              }`}
            ><ClipboardList className="h-3 w-3 shrink-0" /><span className={CHIP_LABEL}>Plan first</span></button>
          </div>
          <button
            onClick={submit} disabled={!text.trim() || submitting}
            title="Crea il task (l'agent parte da Todo)"
            data-testid="composer-send"
            className="shrink-0 rounded-lg bg-emerald-500/80 p-1.5 text-white hover:bg-emerald-500 disabled:opacity-40"
          >{submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</button>
        </div>
      </div>
    </div>
  );
}
