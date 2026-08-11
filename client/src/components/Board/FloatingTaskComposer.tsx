import { useState, useEffect, useRef } from 'react';
import { Bot, Check, ChevronDown, ClipboardList, CornerDownRight, Link2, Loader2, Lock, Plus, Send, Sparkles, X } from 'lucide-react';
import { Menu } from '../Shared/Menu';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { boardApi, boardDrafts, AUTO_PROJECT_ID, STATUS_LABEL, UNASSIGNED_PROJECT_ID, type BoardProjectRef, type LinkProposal } from '../../lib/board';
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
 *
 * Non si smonta MAI mentre la board è viva: il testo a metà, il cursore, i chip
 * scelti e l'altezza del textarea vivono in questo componente, e la bozza dal
 * server si ricarica in modo asincrono — un remount li fa sfarfallare o
 * sparire. Quando serve toglierlo di mezzo (un campo che gli si sovrappone, il
 * drawer a tutto schermo del telefono) lo si NASCONDE con `hidden`/`hiddenBelowLg`.
 */
export function FloatingTaskComposer({ projectId, global, onCreated, onError, hidden, hiddenBelowLg, onOpenTopic }: {
  projectId: string;
  /** Cross-project mode: no implicit board — the project picker chip appears. */
  global: boolean;
  /**
   * Il gesto è andato a buon fine: la board si rinfresca.
   *
   * L'id del task creato viaggia insieme, quando ce n'è uno: è il modo in cui
   * la board sa che quella card l'ha voluta CHI STA QUI — e quindi che può
   * scorrere fino a lei — invece di scoprirla dal broadcast, dove una creazione
   * propria e una di un agent dall'altra parte del mondo sono indistinguibili.
   * La porta dell'orchestratore chiama senza id: lì non nasce nessuna card, la
   * risposta è una sessione di chat.
   */
  onCreated: (createdTaskId?: string) => void;
  onError: (e: string) => void;
  /** Fuori dalla vista (ma vivo): un campo della board gli sta sopra. */
  hidden?: boolean;
  /** Nascosto solo sotto `lg`, dove il drawer del task è un overlay a tutto schermo. */
  hiddenBelowLg?: boolean;
  /**
   * Apre la chat di un topic. Serve alla porta dell'orchestratore: la sua
   * risposta vive nella SUA sessione, e se non la si apre il gesto finisce in
   * un silenzio — che è esattamente il «mai in muto» che la feature vieta.
   */
  onOpenTopic?: (topicId: string) => void;
}) {
  const [text, setText] = useState('');
  /**
   * Le due cose che si possono fare da qui: nascere una card, o parlare
   * all'ORCHESTRATORE — la sessione che ha questa board in contesto.
   *
   * È un interruttore e non un secondo composer perché l'orchestratore non è
   * una superficie: la porta della chat e questa arrivano alla stessa sessione
   * (`server/services/orchestrator.ts`). Duplicare l'input qui vorrebbe dire
   * duplicare anche le regole, e da lì in poi le due porte divergono.
   */
  const [mode, setMode] = useState<'task' | 'orchestrator'>(() => {
    try { return localStorage.getItem('board:composerMode') === 'orchestrator' ? 'orchestrator' : 'task'; }
    catch { return 'task'; }
  });
  const orchestrating = mode === 'orchestrator';
  const setModeStored = (m: 'task' | 'orchestrator') => {
    setMode(m);
    try { localStorage.setItem('board:composerMode', m); } catch { /* private mode */ }
  };
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
  // ── Intake: dove va questo testo? ────────────────────────────────────────
  // Il composer chiede alla board se il testo che stai scrivendo somiglia a un
  // lavoro già aperto. Quello che torna è una PROPOSTA e basta: finché non la
  // scegli il task nasce libero, esattamente come prima. Un intake che sbaglia
  // è peggio di nessun intake — quindi propone, mostra il perché, e disfarlo
  // costa un click.
  const [proposal, setProposal] = useState<LinkProposal | null>(null);
  const [link, setLink] = useState<{ kind: 'subtask' | 'chain'; proposal: LinkProposal } | null>(null);
  // Proposte già scartate PER QUESTA scrittura: in un ref, così ignorarne una
  // non fa ripartire la richiesta che la ripescherebbe.
  const dismissedRef = useRef<Set<string>>(new Set());
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

  // Interroga la board mentre scrivi, ma solo quando c'è abbastanza testo da
  // giudicare (sotto una manciata di caratteri qualunque somiglianza è un caso)
  // e solo finché non hai deciso: una scelta fatta non si ridiscute a ogni
  // tasto. Errore di rete = nessuna proposta, mai un blocco: l'intake è un
  // aiuto, non un passaggio obbligato.
  useEffect(() => {
    const raw = text.trim();
    if (link) return;
    // In modalità orchestratore l'intake non ha oggetto: qui non sta nascendo
    // una card da collegare, si sta parlando. Proporre «sembra legato a X» su
    // una frase come «a che punto siamo?» sarebbe una risposta a una domanda
    // che nessuno ha fatto — e una chiamata alla board per ogni tasto.
    if (orchestrating) { setProposal(null); return; }
    if (raw.length < 12 || !target || target === UNASSIGNED_PROJECT_ID) { setProposal(null); return; }
    let alive = true;
    const timer = setTimeout(() => {
      boardApi.suggestLink(target, raw)
        .then((p) => { if (alive) setProposal(p && !dismissedRef.current.has(p.targetTaskId) ? p : null); })
        .catch(() => { if (alive) setProposal(null); });
    }, 450);
    return () => { alive = false; clearTimeout(timer); };
  }, [text, target, link, orchestrating]);

  // Cambiare board azzera la scelta: un collegamento vive su UNA board, e
  // trascinarlo altrove vorrebbe dire attaccare il task a una card che su quel
  // progetto non esiste.
  useEffect(() => { setLink(null); setProposal(null); dismissedRef.current.clear(); }, [target]);

  const acceptProposal = (kind: 'subtask' | 'chain') => {
    if (!proposal) return;
    setLink({ kind, proposal });
    setProposal(null);
  };
  const dismissProposal = () => {
    if (proposal) dismissedRef.current.add(proposal.targetTaskId);
    setProposal(null);
  };
  const clearLink = () => {
    if (link) dismissedRef.current.add(link.proposal.targetTaskId);
    setLink(null);
  };

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
    if (orchestrating) {
      // «Progetto auto» non vale qui: l'orchestratore È la sessione DI una
      // board, e senza sapere quale non c'è nessuno stato da mettergli davanti.
      if (autoTarget || noneTarget) { onError("Scegli la board di cui parlare all'orchestratore."); setProjOpen(true); return; }
      setSubmitting(true);
      try {
        const { topicId } = await boardApi.askOrchestrator(target, raw);
        setText('');
        boardDrafts.clearComposer();
        if (taRef.current) taRef.current.style.height = 'auto';
        // La risposta arriva nella sessione dell'orchestratore: aprirla è parte
        // del gesto, non un extra. Mandare e non mostrare dove è finito sarebbe
        // il muto che questa feature esiste per non fare.
        onOpenTopic?.(topicId);
        onCreated();
      } catch (e) { onError(e instanceof Error ? e.message : 'invio fallito'); }
      finally { setSubmitting(false); }
      return;
    }
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
      // Il collegamento viaggia DENTRO la create: non esiste un istante in cui
      // il task è nato e il link non c'è ancora (o peggio, c'è senza che
      // nessuno l'abbia scelto). `intakeLink` dice al server di scrivere il
      // perché nei thread di entrambe le card.
      const created = await boardApi.create(target, {
        text: title, description, status: 'todo', planFirst,
        model: model ?? undefined, priority: prio ?? undefined,
        ...(link?.kind === 'subtask' ? { parentTaskId: link.proposal.targetTaskId } : {}),
        ...(link?.kind === 'chain' ? { blockedByTaskId: link.proposal.targetTaskId, reuseBlockerContext: true } : {}),
        ...(link ? { intakeLink: true, intakeReason: link.proposal.reason } : {}),
      });
      setText('');
      setPlanFirst(false);
      setModel(null);
      setPrio(null);
      setLink(null);
      setProposal(null);
      dismissedRef.current.clear();
      boardDrafts.clearComposer();
      if (taRef.current) taRef.current.style.height = 'auto';
      onCreated(created.id);
    } catch (e) { onError(e instanceof Error ? e.message : 'create failed'); }
    finally { setSubmitting(false); }
  };

  return (
    <div
      // `hidden` batte il breakpoint: display è UNA proprietà, quindi le due
      // classi non si sommano — vanno scelte, non concatenate.
      className={`pointer-events-none absolute inset-x-0 bottom-6 z-10 justify-center px-4 transition-transform duration-150 ease-out ${
        hidden ? 'hidden' : hiddenBelowLg ? 'hidden lg:flex' : 'flex'
      }`}
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
          placeholder={orchestrating ? 'Chiedi all’orchestratore — «a che punto siamo?», «sposta le tre in review»…' : "Descrivi un task per l'agent…"}
          className={`block max-h-40 w-full resize-none overflow-y-auto bg-transparent px-3.5 py-3 text-sm leading-5 text-app-text outline-none transition-[min-height] duration-200 ease-out placeholder:text-app-placeholder ${
            expanded ? 'min-h-[4.5rem]' : 'min-h-0'
          }`}
        />
        {/* Intake. Una riga sola, sopra i chip: la proposta con il PERCHÉ a
            portata di occhio (title = la frase intera), e due bottoni — quello
            consigliato acceso, l'altro a un click. Il terzo bottone è "no": il
            task nasce libero, che è anche ciò che succede se non tocchi niente. */}
        {expanded && !orchestrating && (proposal || link) && (
          <div
            data-testid="composer-intake"
            className="mx-2.5 mb-2 flex items-center gap-2 overflow-x-auto rounded-lg border border-app-border bg-black/5 px-2 py-1.5 text-[11px] scrollbar-hide dark:bg-white/5"
          >
            {link ? (
              <>
                {link.kind === 'subtask'
                  ? <CornerDownRight className="h-3 w-3 shrink-0 text-emerald-400" />
                  : <Lock className="h-3 w-3 shrink-0 text-amber-400" />}
                <span className="min-w-0 flex-1 truncate text-app-text" title={link.proposal.reason}>
                  {link.kind === 'subtask'
                    ? <>Sottotask di <span className="text-app-text-heading">«{link.proposal.targetText}»</span></>
                    : <>Parte quando chiude <span className="text-app-text-heading">«{link.proposal.targetText}»</span>, riprendendo quel filo</>}
                </span>
                <button
                  onClick={clearLink}
                  data-testid="composer-intake-unlink"
                  title="Togli il collegamento: il task nasce libero"
                  className="shrink-0 rounded p-0.5 text-app-text-muted hover:bg-black/10 hover:text-app-text dark:hover:bg-white/10"
                ><X className="h-3 w-3" /></button>
              </>
            ) : proposal && (
              <>
                <Link2 className="h-3 w-3 shrink-0 text-app-text-muted" />
                <span className="min-w-0 flex-1 truncate text-app-text-secondary" title={proposal.reason}>
                  Sembra legato a <span className="text-app-text-heading">«{proposal.targetText}»</span>
                  <span className="text-app-text-muted"> ({STATUS_LABEL[proposal.targetStatus].toLowerCase()})</span>
                </span>
                <button
                  onClick={() => acceptProposal('chain')}
                  data-testid="composer-intake-chain"
                  title="Non parte finché quella card non chiude, poi riprende il suo filo"
                  className={`shrink-0 rounded-md px-2 py-1 transition-colors ${
                    proposal.recommended === 'chain'
                      ? 'bg-amber-500/25 text-amber-200'
                      : 'bg-black/5 text-app-text-secondary hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10'
                  }`}
                >Incatena</button>
                <button
                  onClick={() => acceptProposal('subtask')}
                  data-testid="composer-intake-subtask"
                  title="Diventa un pezzo di quella card (compare nel suo elenco)"
                  className={`shrink-0 rounded-md px-2 py-1 transition-colors ${
                    proposal.recommended === 'subtask'
                      ? 'bg-emerald-500/25 text-emerald-200'
                      : 'bg-black/5 text-app-text-secondary hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10'
                  }`}
                >Sottotask</button>
                <button
                  onClick={dismissProposal}
                  data-testid="composer-intake-dismiss"
                  title="No: task nuovo, senza collegamenti"
                  className="shrink-0 rounded p-0.5 text-app-text-muted hover:bg-black/10 hover:text-app-text dark:hover:bg-white/10"
                ><X className="h-3 w-3" /></button>
              </>
            )}
          </div>
        )}
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
            {/* L'interruttore fra le due cose che si fanno da qui. Primo chip:
                cambia il significato di tutto il resto della riga, quindi si
                legge prima di scegliere un modello o una priorità. */}
            <button
              onClick={() => setModeStored(orchestrating ? 'task' : 'orchestrator')}
              data-testid="composer-mode-chip"
              title={orchestrating
                ? "Stai parlando all'orchestratore (la sessione con questa board in contesto). Clicca per tornare a creare un task."
                : 'Stai creando un task. Clicca per parlare invece all’orchestratore della board.'}
              className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
                orchestrating ? 'bg-sky-500/25 text-sky-200' : 'bg-black/5 text-app-text-secondary hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10'
              }`}
            >
              {orchestrating ? <Bot className="h-3 w-3 shrink-0" /> : <Plus className="h-3 w-3 shrink-0" />}
              <span className={CHIP_LABEL}>{orchestrating ? 'Orchestratore' : 'Nuovo task'}</span>
            </button>
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
            {/* Modello, priorità e plan-first descrivono come nascerà una CARD:
                parlando all'orchestratore non hanno un oggetto, e lasciarli
                accesi prometterebbe un effetto che non c'è. */}
            {!orchestrating && (<>
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
            </>)}
          </div>
          <button
            onClick={submit} disabled={!text.trim() || submitting}
            title={orchestrating ? "Manda all'orchestratore (risponde nella sua chat)" : "Crea il task (l'agent parte da Todo)"}
            data-testid="composer-send"
            className="shrink-0 rounded-lg bg-emerald-500/80 p-1.5 text-white hover:bg-emerald-500 disabled:opacity-40"
          >{submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</button>
        </div>
      </div>
    </div>
  );
}
