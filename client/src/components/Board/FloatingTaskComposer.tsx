import { useState, useEffect, useRef, useCallback } from 'react';
import { Check, ChevronDown, ClipboardList, CornerDownRight, Link2, Loader2, Lock, Paperclip, Send, Sparkles, X } from 'lucide-react';
import { Menu } from '../Shared/Menu';
import { useToast } from '../Shared/Toast';
import { insertAtCaret } from '../../lib/insertAtCaret';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { ZoomableImage } from '../Shared/ImageLightbox';
import { boardApi, boardDrafts, AUTO_PROJECT_ID, STATUS_LABEL, UNASSIGNED_PROJECT_ID, type BoardProjectRef, type LinkProposal, type TaskStatus } from '../../lib/board';
import { addBoardProject, projectNameFromId, useBoardProjects, useNewProjectDir } from '../../lib/boardProjectsStore';
import { getProvidersSnapshotState, subscribeProvidersSnapshot } from '../../lib/providersSnapshotStore';
import { writeCursor, markActiveComposer, restoreCursor } from '../../lib/composerCursor';
import { CHIP_LABEL, COMPOSER_CURSOR_KEY, PRIORITY_DOT, PRIORITY_LABEL, PRIORITY_ORDER } from './constants';
import { autoGrow, friendlyModelLabel } from './format';
import { StatusIcon } from './atoms';
import { ProjectPickerBody } from './ProjectPicker';
import { POPOVER_ITEM } from '@/lib/popoverStyles';
import { useT } from '../../hooks/useT';
import { DictationButton } from '../Shared/DictationButton';
import { getMediaUrl } from '../../lib/api';
import { dragCarriesFiles, filesFromDrop, imagesFromClipboard, uploadAttachment, MAX_ATTACHMENTS, type StagedAttachment } from '../../lib/attachments';
import { titoloDaTesto } from '../../../../shared/task-title';
import { draftPreviewOf, type DraftPreview } from './draftPreview';

/** Le due colonne in cui un task può NASCERE, nell'ordine in cui il menu le
 *  offre, ognuna con la CHIAVE della riga che dice cosa succede scegliendola.
 *  Chiave e non testo: questa è una costante di modulo, e `tr` esiste solo
 *  dentro il componente. Le colonne più avanti (in corso, review, done) non
 *  sono un'origine: ci si arriva. */
const START_CHOICES: readonly (readonly [BirthStatus, string])[] = [
  ['todo', 'board.composer.startTodoHint'],
  ['backlog', 'board.composer.startBacklogHint'],
];

/** Le sole due colonne che sono un'ORIGINE (le altre si raggiungono). */
type BirthStatus = Extract<TaskStatus, 'todo' | 'backlog'>;

/**
 * The "dai questo all'agent" entry point: a floating input at the bottom of
 * the board. Collapsed it's a slim pill; on focus it RISES slightly and
 * expands (the chip row, project select in the global board, submit) — and
 * eases back on blur. Title = first line, full text goes to the description,
 * and the dispatched agent polishes the wording (kickoff rule).
 *
 * ── DOVE NASCE IL TASK, E COME PARTE ────────────────────────────────────────
 * Il chip «Avvio» risponde alla sola domanda che l'invio pone davvero: cosa
 * succede appena premo Invio. Todo è il segnale di dispatch (un agent la
 * prende dalla coda), Backlog è la cassetta delle idee (nasce ferma, la
 * promuovi tu quando è il momento). Prima era una scelta che non esisteva: il
 * composer scriveva `status: 'todo'` fisso, quindi ogni pensiero buttato lì
 * dentro faceva partire un agent, e l'unico modo di parcheggiarlo era crearlo
 * e poi trascinarlo indietro.
 *
 * «Piano prima» sta nello STESSO menu perché è la seconda metà della stessa
 * domanda (come parte), non un quinto chip: era un toggle nudo, l'unico
 * comando della riga senza etichetta di stato né spiegazione — acceso o spento
 * si capiva solo dal colore. Dentro il menu ha un nome, una riga che dice cosa
 * fa e una spunta, come Modello e Priorità; sul chip resta visibile come
 * glifo viola, così lo stato si legge anche a menu chiuso. Le due scelte
 * restano indipendenti: un task può nascere in Backlog E chiedere il piano,
 * che è quello che serve quando lo promuoverai fra una settimana.
 *
 * Non si smonta MAI mentre la board è viva: il testo a metà, il cursore, i chip
 * scelti e l'altezza del textarea vivono in questo componente, e la bozza dal
 * server si ricarica in modo asincrono — un remount li fa sfarfallare o
 * sparire. Quando serve toglierlo di mezzo (un campo che gli si sovrappone, il
 * drawer a tutto schermo del telefono) lo si NASCONDE con `hidden`/`hiddenBelowLg`.
 */
export function FloatingTaskComposer({ projectId, global, onCreated, onError, hidden, hiddenBelowLg, onDraft }: {
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
  /** WHAT IS ABOUT TO BE CREATED, as the board should preview it: the ghost
   *  card in the birth column (see `draftPreview.ts`). `null` when there is
   *  nothing to preview. Called on every change of text, attachments or birth
   *  column, so the ghost follows the typing. */
  onDraft?: (draft: DraftPreview | null) => void;
}) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  /* THE ATTACHMENTS OF THE TASK BEING BORN.
     A card's thread accepted a pasted image; this field, which is where the
     work actually starts, accepted nothing: no paste, no drop, no paperclip.
     Whoever opened the board holding a screenshot of the error had to create
     the task, open it, and attach the file afterwards.
     Files upload straight away (`/api/upload`) and wait here: they travel with
     the create, and the server writes them on the card as its first message. */
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [planFirst, setPlanFirst] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Avvio: dove nasce il task (Todo = parte, Backlog = resta ferma) e se prima
  // dell'implementazione vuoi il piano. Un chip solo, due domande vicine.
  const [startOpen, setStartOpen] = useState(false);
  const [birthStatus, setBirthStatus] = useState<BirthStatus>('todo');
  const startBtnRef = useRef<HTMLButtonElement>(null);
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
        // Le bozze scritte prima che l'avvio esistesse non hanno il campo:
        // l'assenza vale Todo, cioè come si comportava il composer allora.
        if (d.status === 'backlog') setBirthStatus('backlog');
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
    boardDrafts.putComposer({ text, model, prio, planFirst, status: birthStatus });
  }, [text, model, prio, planFirst, birthStatus]);
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

  /* Dettatura. Un task si descrive a voce meglio di come si scrive, e fin qui
     la voce esisteva solo in chat: chi apriva la board per buttare dentro un
     lavoro doveva scriverlo a mano, o dettarlo altrove e copiarlo qui.
     Il testo entra AL CURSORE (`insertAtCaret`) e non in coda, così una
     dettatura in due riprese resta nell'ordine in cui l'hai detta. */
  const tr = useT();
  const toast = useToast();
  const insertDictated = useCallback((spoken: string) => {
    const ta = taRef.current;
    const at = ta ? ta.selectionStart : Number.MAX_SAFE_INTEGER;
    setText(prev => {
      const { next, caret } = insertAtCaret(prev, at, spoken);
      // Il cursore si rimette DOPO che React ha scritto il valore nuovo:
      // assegnarlo adesso lo sposterebbe su un testo che non c'è ancora.
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(caret, caret);
        writeCursor(COMPOSER_CURSOR_KEY, caret, caret);
        autoGrow(el);
      });
      return next;
    });
  }, []);
  const dictationError = useCallback((m: string) => toast.error(m), [toast]);
  const dictationNotice = useCallback((m: string) => toast.warning(m, 9000), [toast]);

  /* An attached file uploads AT ONCE: by the time Enter is pressed the task
     must be born with its files, not wait for a second network round. Past the
     cap the extra files are dropped (the paperclip is already disabled, so the
     limit is visible before it bites). */
  const addFiles = async (files: File[] | FileList) => {
    const list = Array.from(files);
    if (!list.length) return;
    setUploading(true);
    try {
      for (const file of list.slice(0, MAX_ATTACHMENTS - attachments.length)) {
        const staged = await uploadAttachment(file);
        setAttachments((prev) => [...prev, staged]);
      }
    } catch (e) { onError(e instanceof Error ? e.message : 'upload failed'); }
    finally { setUploading(false); }
  };

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
  const expanded = focused || projOpen || modelOpen || prioOpen || startOpen || text.trim().length > 0
    || attachments.length > 0 || dragOver;

  const onFocus = () => {
    setFocused(true);
    markActiveComposer(COMPOSER_CURSOR_KEY);
  };
  // Collapse only when focus truly LEFT the composer (not moving between its
  // own controls) — otherwise clicking "Plan first" would blur-shrink it.
  const onBlurCapture = (e: React.FocusEvent) => {
    if (projOpen || modelOpen || startOpen) return;
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
  const todo = birthStatus === 'todo';

  // THE GHOST FOLLOWS THE TYPING. Same inputs as the create, same title cut
  // (`draftPreviewOf` calls `titoloDaTesto`), so what the column shows while
  // you write is what it will hold when you press Enter. It clears with the
  // text (the create empties it) and on unmount, so no column keeps a ghost
  // of a composer that is gone.
  useEffect(() => {
    if (!onDraft) return;
    onDraft(draftPreviewOf(text, attachments, birthStatus));
  }, [onDraft, text, attachments, birthStatus]);
  useEffect(() => () => { onDraft?.(null); }, [onDraft]);

  // Interroga la board mentre scrivi, ma solo quando c'è abbastanza testo da
  // giudicare (sotto una manciata di caratteri qualunque somiglianza è un caso)
  // e solo finché non hai deciso: una scelta fatta non si ridiscute a ogni
  // tasto. Errore di rete = nessuna proposta, mai un blocco: l'intake è un
  // aiuto, non un passaggio obbligato.
  useEffect(() => {
    const raw = text.trim();
    if (link) return;
    if (raw.length < 12 || !target || target === UNASSIGNED_PROJECT_ID) { setProposal(null); return; }
    let alive = true;
    const timer = setTimeout(() => {
      boardApi.suggestLink(target, raw)
        .then((p) => { if (alive) setProposal(p && !dismissedRef.current.has(p.targetTaskId) ? p : null); })
        .catch(() => { if (alive) setProposal(null); });
    }, 450);
    return () => { alive = false; clearTimeout(timer); };
  }, [text, target, link]);

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
    // IL TAGLIO STA IN `shared/task-title.ts`, e taglia su PAROLA.
    //
    // Qui c'era `firstLine.slice(0, 77) + '…'`: un taglio al carattere,
    // ovunque cadesse. Su un testo scritto va quasi sempre bene — chi scrive
    // mette il titolo in cima — ma su un DETTATO diventa il preambolo mozzato:
    // «Potremmo fare una roba molto figa per poter assicurarci che il nostro
    // browser…» (card 235afe11, 20/08), settantotto caratteri che non dicono
    // di che cosa parla la card.
    //
    // Questa e' la RETE, non la soluzione: il titolo vero lo ricava il server
    // alla nascita della card, con lo stesso modello che nomina le chat
    // (`services/task-title.ts`). Quando quello non c'e' — nessun modello
    // configurato, rete assente — resta questo, che almeno non spezza le
    // parole a meta'.
    const { title, description } = titoloDaTesto(raw);
    setSubmitting(true);
    try {
      // Il collegamento viaggia DENTRO la create: non esiste un istante in cui
      // il task è nato e il link non c'è ancora (o peggio, c'è senza che
      // nessuno l'abbia scelto). `intakeLink` dice al server di scrivere il
      // perché nei thread di entrambe le card.
      const created = await boardApi.create(target, {
        text: title, description, status: birthStatus, planFirst,
        model: model ?? undefined, priority: prio ?? undefined,
        // Attachments ride INSIDE the create, like the intake link: the server
        // writes them on the card before dispatching it, so the agent that
        // picks it up already has them instead of seeing them land later.
        ...(attachments.length ? { media: attachments.map((a) => a.path) } : {}),
        ...(link?.kind === 'subtask' ? { parentTaskId: link.proposal.targetTaskId } : {}),
        ...(link?.kind === 'chain' ? { blockedByTaskId: link.proposal.targetTaskId, reuseBlockerContext: true } : {}),
        ...(link ? { intakeLink: true, intakeReason: link.proposal.reason } : {}),
      });
      setText('');
      setAttachments([]);
      setPlanFirst(false);
      setBirthStatus('todo');
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
        // DRAG A FILE ONTO THE PILL AND IT IS ATTACHED. The target is the
        // whole pill, not the text field: whoever drags aims at the object they
        // can see. A drag with no file (a layout pane, a text selection, a
        // board card) passes through, via `dragCarriesFiles`, or the board
        // would lose its own drag and drop underneath this one.
        onDragOver={(e) => { if (!dragCarriesFiles(e.dataTransfer)) return; e.preventDefault(); e.stopPropagation(); setDragOver(true); }}
        onDragLeave={(e) => { if (e.currentTarget.contains(e.relatedTarget as Node | null)) return; setDragOver(false); }}
        onDrop={(e) => {
          if (!dragCarriesFiles(e.dataTransfer)) return;
          e.preventDefault(); e.stopPropagation();
          setDragOver(false);
          void addFiles(filesFromDrop(e.dataTransfer));
        }}
        data-testid="board-task-composer"
        // @container: la riga dei chip qui sotto si compatta sulla larghezza di
        // QUESTA card — cioè della pane — non del viewport. I breakpoint `sm:`
        // non scattano mai dentro una pane stretta su uno schermo largo, che è
        // il caso normale in un layout a riquadri. Stesso schema del composer
        // della chat (ChatInput.tsx).
        className={`input-glass @container pointer-events-auto relative w-full max-w-2xl rounded-2xl border shadow-2xl shadow-black/50 transition-all duration-200 ease-out ${
          dragOver ? '-translate-y-2 border-emerald-400/70' : expanded ? '-translate-y-2 border-app-border-light' : 'translate-y-0 border-app-border'
        }`}
      >
        {dragOver && (
          <div
            data-testid="composer-drop-hint"
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border border-dashed border-emerald-400/70 bg-app-bg/70 text-xs text-emerald-300"
          >{tr('board.composer.dropToAttach')}</div>
        )}
        <textarea
          value={text} rows={1}
          ref={(el) => { taRef.current = el; autoGrow(el); }}
          onChange={(e) => { setText(e.target.value); autoGrow(e.currentTarget); saveCursor(); }}
          onSelect={saveCursor}
          onKeyUp={saveCursor}
          onClick={saveCursor}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          // A pasted image becomes an attachment and NOT text: without this,
          // pasting a screenshot into the field did nothing at all. Every other
          // paste (text, a link) behaves exactly as before.
          onPaste={(e) => {
            const images = imagesFromClipboard(e.clipboardData);
            if (images.length) { e.preventDefault(); void addFiles(images); }
          }}
          placeholder={tr('board.composer.placeholder')}
          className={`block max-h-40 w-full resize-none overflow-y-auto bg-transparent px-3.5 py-3 text-sm leading-5 text-app-text outline-none transition-[min-height] duration-200 ease-out placeholder:text-app-placeholder ${
            expanded ? 'min-h-[4.5rem]' : 'min-h-0'
          }`}
        />
        {/* The staged attachments: a thumbnail for images, the name for
            everything else. What you are about to send is visible before you
            send it, and one x removes it. Same shape as a task's thread. */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2.5 pb-2" data-testid="composer-attachments">
            {attachments.map((a) => (
              <span key={a.path} className="group/att relative">
                {a.isImage ? (
                  // Click = the lightbox, like every other thumbnail of the
                  // app (card 058ea722): what you are about to send can be
                  // looked at before you send it.
                  <ZoomableImage src={getMediaUrl(a.path)} alt={a.name} title={a.name} testId="composer-attachment-image" className="h-12 w-12 rounded object-cover" />
                ) : (
                  <span className="flex max-w-[10rem] items-center gap-1 rounded bg-black/5 px-1.5 py-1 text-[11px] text-app-text-heading dark:bg-white/10">
                    <Paperclip className="h-3 w-3 shrink-0" /><span className="truncate">{a.name}</span>
                  </span>
                )}
                <button
                  onClick={() => setAttachments((prev) => prev.filter((p) => p.path !== a.path))}
                  title={tr('board.task.removeAttachmentTitle')}
                  className="absolute -right-1.5 -top-1.5 hidden rounded-full bg-elevated p-0.5 text-app-text group-hover/att:block"
                ><X className="h-2.5 w-2.5" /></button>
              </span>
            ))}
          </div>
        )}
        {/* Intake. Una riga sola, sopra i chip: la proposta con il PERCHÉ a
            portata di occhio (title = la frase intera), e due bottoni — quello
            consigliato acceso, l'altro a un click. Il terzo bottone è "no": il
            task nasce libero, che è anche ciò che succede se non tocchi niente. */}
        {expanded && (proposal || link) && (
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
                    ? <>{tr('board.composer.subtaskOf')} <span className="text-app-text-heading">«{link.proposal.targetText}»</span></>
                    : <>{tr('board.composer.chainedStart')} <span className="text-app-text-heading">«{link.proposal.targetText}»</span>{tr('board.composer.chainedEnd')}</>}
                </span>
                <button
                  onClick={clearLink}
                  data-testid="composer-intake-unlink"
                  title={tr('board.composer.unlinkTitle')}
                  className="shrink-0 rounded p-0.5 text-app-text-muted hover:bg-black/10 hover:text-app-text dark:hover:bg-white/10"
                ><X className="h-3 w-3" /></button>
              </>
            ) : proposal && (
              <>
                <Link2 className="h-3 w-3 shrink-0 text-app-text-muted" />
                <span className="min-w-0 flex-1 truncate text-app-text-secondary" title={proposal.reason}>
                  {tr('board.composer.looksLinkedTo')} <span className="text-app-text-heading">«{proposal.targetText}»</span>
                  <span className="text-app-text-muted"> ({STATUS_LABEL[proposal.targetStatus].toLowerCase()})</span>
                </span>
                <button
                  onClick={() => acceptProposal('chain')}
                  data-testid="composer-intake-chain"
                  title={tr('board.composer.chainTitle')}
                  className={`shrink-0 rounded-md px-2 py-1 transition-colors ${
                    proposal.recommended === 'chain'
                      ? 'bg-amber-500/25 text-amber-200'
                      : 'bg-black/5 text-app-text-secondary hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10'
                  }`}
                >{tr('board.composer.chain')}</button>
                <button
                  onClick={() => acceptProposal('subtask')}
                  data-testid="composer-intake-subtask"
                  title={tr('board.composer.subtaskTitle')}
                  className={`shrink-0 rounded-md px-2 py-1 transition-colors ${
                    proposal.recommended === 'subtask'
                      ? 'bg-emerald-500/25 text-emerald-200'
                      : 'bg-black/5 text-app-text-secondary hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10'
                  }`}
                >{tr('board.composer.subtask')}</button>
                <button
                  onClick={dismissProposal}
                  data-testid="composer-intake-dismiss"
                  title={tr('board.composer.dismissTitle')}
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
            {global && (
              <>
                <button
                  ref={projBtnRef}
                  onClick={() => setProjOpen(true)}
                  data-testid="composer-project-chip"
                  title={autoTarget
                    ? tr('board.composer.projectAutoTitle')
                    : targetLabel ? tr('board.composer.projectNamedTitle', { label: targetLabel }) : tr('board.composer.projectPickTitle')}
                  // L'UNICO chip che può stringersi (l'etichetta è troncabile),
                  // con un pavimento: sotto ~5.5rem resterebbero icona e chevron
                  // senza una lettera di nome, che è peggio di far scorrere la riga.
                  className="flex min-w-[5.5rem] max-w-[13rem] items-center gap-1.5 rounded-md bg-black/5 px-2 py-1 text-xs text-app-text hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10"
                >
                  {autoTarget
                    ? <Sparkles className="h-3 w-3 shrink-0 text-app-text-muted" />
                    : <ProjectFavicon path={targetRef?.path ?? ''} size={13} fallback={<span className={`h-1.5 w-1.5 shrink-0 rounded-full ${targetProject && !noneTarget ? 'bg-emerald-400' : 'bg-app-text-faint'}`} />} />}
                  <span className="truncate">{targetLabel || tr('board.composer.projectPlaceholder')}</span>
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
              title={model ? tr('board.composer.modelNamedTitle', { label: friendlyModelLabel(model) }) : tr('board.composer.modelAutoTitle')}
              className="flex shrink-0 items-center gap-1 rounded-md bg-black/5 px-2 py-1 text-[11px] text-app-text-heading hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10"
            ><Sparkles className="h-3 w-3 shrink-0 text-app-text-muted" /><span className={CHIP_LABEL}>{model ? friendlyModelLabel(model) : tr('board.composer.modelAutoChip')}</span><ChevronDown className="h-3 w-3 shrink-0 text-app-text-muted" /></button>
            <Menu open={modelOpen} anchorRef={modelBtnRef} onClose={() => setModelOpen(false)} minWidth={170} role="listbox">
              <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.composer.model')}</p>
              <button
                role="option" aria-selected={model === null}
                onClick={() => { setModel(null); setModelOpen(false); }}
                title={tr('board.composer.modelAutoOptionTitle')}
                className={POPOVER_ITEM}
              >
                <span className="min-w-0 flex-1">{tr('board.composer.modelAuto')}</span>
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
              title={prio !== null ? tr('board.composer.priorityNamedTitle', { label: PRIORITY_LABEL[prio] }) : tr('board.composer.priorityAutoTitle')}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-black/5 px-2 py-1 text-[11px] text-app-text-heading hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10"
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${prio !== null ? PRIORITY_DOT[prio] : 'border border-app-text-faint'}`} />
              <span className={CHIP_LABEL}>{prio !== null ? PRIORITY_LABEL[prio] : tr('board.composer.priorityAutoChip')}</span>
              <ChevronDown className="h-3 w-3 shrink-0 text-app-text-muted" />
            </button>
            <Menu open={prioOpen} anchorRef={prioBtnRef} onClose={() => setPrioOpen(false)} minWidth={170} role="listbox">
              <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.task.priority')}</p>
              <button
                role="option" aria-selected={prio === null}
                onClick={() => { setPrio(null); setPrioOpen(false); }}
                title={tr('board.composer.priorityAutoOptionTitle')}
                className={POPOVER_ITEM}
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-app-text-faint" />
                <span className="min-w-0 flex-1">{tr('board.composer.priorityAuto')}</span>
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
              ref={startBtnRef}
              onClick={() => setStartOpen(true)}
              data-testid="composer-start-chip"
              title={`${tr(todo ? 'board.composer.startTodoTitle' : 'board.composer.startBacklogTitle')}${
                planFirst ? tr('board.composer.startPlanFirstTitle') : ''
              }`}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-black/5 px-2 py-1 text-[11px] text-app-text-heading hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10"
            >
              <StatusIcon status={birthStatus} className="h-3 w-3" />
              <span className={CHIP_LABEL}>{STATUS_LABEL[birthStatus]}</span>
              {/* Lo stato del piano si legge a menu CHIUSO: dentro il menu ha
                  nome e spiegazione, qui basta il glifo acceso. */}
              {planFirst && <ClipboardList className="h-3 w-3 shrink-0 text-violet-300" />}
              <ChevronDown className="h-3 w-3 shrink-0 text-app-text-muted" />
            </button>
            <Menu open={startOpen} anchorRef={startBtnRef} onClose={() => setStartOpen(false)} minWidth={240} role="menu">
              <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.composer.start')}</p>
              {START_CHOICES.map(([s, hintKey]) => (
                <button
                  key={s} role="menuitemradio" aria-checked={birthStatus === s}
                  onClick={() => { setBirthStatus(s); setStartOpen(false); }}
                  data-testid={`composer-start-${s}`}
                  className={POPOVER_ITEM}
                >
                  <StatusIcon status={s} className="h-3 w-3" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span>{STATUS_LABEL[s]}</span>
                    <span className="text-[11px] leading-tight text-app-text-muted">{tr(hintKey)}</span>
                  </span>
                  {birthStatus === s && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                </button>
              ))}
              {/* Il piano è una scelta INDIPENDENTE dalla colonna, non una terza
                  voce dell'elenco: il filo lo dice, e il menu resta aperto al
                  click perché una spunta che si accende vuole essere vista. */}
              <div className="my-1 h-px bg-app-border" />
              <button
                role="menuitemcheckbox" aria-checked={planFirst}
                onClick={() => setPlanFirst((v) => !v)}
                data-testid="composer-plan-first"
                className={POPOVER_ITEM}
              >
                <ClipboardList className={`h-3 w-3 shrink-0 ${planFirst ? 'text-violet-300' : 'text-app-text-muted'}`} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>{tr('board.task.planFirst')}</span>
                  <span className="text-[11px] leading-tight text-app-text-muted">{tr('board.composer.planFirstHint')}</span>
                </span>
                {planFirst && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
              </button>
            </Menu>
          </div>
          {/* Il microfono sta ATTACCATO all'invio, non fra i chip: i chip
              scelgono come nascerà il task, questi due riempiono il campo e lo
              chiudono. Nascosto del tutto se non c'è un motore di trascrizione,
              perché un tasto che non può funzionare è peggio di uno assente. */}
          {/* Lo STESSO bottone del thread di un task e della chat: estratto in
              `Shared/DictationButton` perche' tre copie divergono, e sono gia'
              divergite una volta (il thread non ce l'aveva affatto). */}
          {/* The paperclip next to the microphone: paste and drop are the fast
              gestures, but without a button nobody learns that this field takes
              files at all, and on a phone neither gesture exists. */}
          <input
            ref={fileInputRef} type="file" multiple className="hidden"
            data-testid="composer-file-input"
            onChange={(e) => { if (e.target.files?.length) void addFiles(e.target.files); e.target.value = ''; }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || attachments.length >= MAX_ATTACHMENTS}
            title={tr('board.composer.attachTitle')}
            data-testid="composer-attach"
            className="shrink-0 rounded-lg p-1.5 text-app-text-secondary hover:bg-black/10 disabled:opacity-40 dark:hover:bg-white/10"
          >{uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}</button>
          <DictationButton
            testId="task-composer-dictation"
            onText={insertDictated}
            onError={dictationError}
            onNotice={dictationNotice}
          />
          <button
            onClick={submit} disabled={!text.trim() || submitting}
            title={tr(todo ? 'board.composer.sendTodoTitle' : 'board.composer.sendBacklogTitle')}
            data-testid="composer-send"
            className="shrink-0 rounded-lg bg-emerald-500/80 p-1.5 text-white hover:bg-emerald-500 disabled:opacity-40"
          >{submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</button>
        </div>
      </div>
    </div>
  );
}
