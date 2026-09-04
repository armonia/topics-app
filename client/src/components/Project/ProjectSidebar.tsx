import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { useT } from '../../hooks/useT';
import { createPortal } from 'react-dom';
import { ChevronRight, FolderTree, GitBranch, CirclePlay, RefreshCw, PanelLeftOpen, PanelLeftClose, FilePlus, FolderPlus, ChevronsDownUp } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { NO_DRAG_REGION } from '../../lib/shell/dragRegion';
import { RAISED_CONTROL, RESTING_SURFACE, ROW_ACTION_BOX, ROW_PX, SECTION_CARD, TAB_GAP_CLASS, TAB_LABEL, TAB_RESTING_SURFACE } from '../../lib/selectionStyles';
import { capSezione } from './projectSidebarHeights';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { ScriptRunner } from './ScriptRunner';
import { FileExplorer, type FileExplorerHandle } from './FileExplorer';
import { useScripts } from '../../hooks/useScripts';
import { useGitStatus } from '../../hooks/useGitStatus';
import { isRecentFailure } from '../../lib/processFailure';
import { hasGitStateToShow } from '../../lib/gitVisibility';
import { DRAG_SLOP_PX } from '../../hooks/useGridResize';
import type { WSMessage } from '../../types';
import { useHoverReveal } from '../../hooks/useHoverReveal';

// Git is heavy (diff rendering) — keep lazy
const GitChanges = lazy(() => import('./GitChanges').then(m => ({ default: m.GitChanges })));

interface ProjectSidebarProps {
  projectPath: string;
  /** Header label override — the task title for a task workspace (whose path
   *  basename is an opaque `<id8>`). Falls back to the path's folder name. */
  displayName?: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenFile?: (path: string) => void;
  onWSMessage?: (handler: (msg: WSMessage) => void) => () => void;
  onOpenProcessLog?: (processId: string, scriptName: string) => void;
  /**
   * DOVE VA LA BARRA CHIUSA: dentro la riga delle tab, non accanto a essa.
   *
   * «Facciamo diventare la sidebar chiusa direttamente parte della tabbar
   * progetto, in linea e non disposte verticalmente ma orizzontalmente, usando
   * il design a card e riportando anche titolo progetto, così da togliere linea
   * laterale inutile quando collassata» (Attilio, 09/08).
   *
   * Chiusa, questa colonna era una rail verticale da 40px col suo `border-r`:
   * una seconda superficie accanto alla riga di chrome, con una tinta sua e un
   * filo che scendeva per tutta l'altezza della finestra per contenere tre
   * icone. Adesso i suoi comandi vivono NELLA barra, in fila con le tab e con la
   * loro stessa grammatica — e la colonna, chiusa, non esiste proprio.
   *
   * Arriva come NODO e non come ref perché il nodo lo crea `ProjectWindow` una
   * volta sola (`document.createElement`) e `GroupLayout` lo aggancia dentro la
   * prima barra: esiste già al primo render, quindi il portale ha subito dove
   * scrivere e non c'è il fotogramma in cui la rail vecchia lampeggia prima di
   * sparire.
   *
   * OBBLIGATORIO, e non e' pignoleria di tipi: finche' era opzionale restava in
   * piedi una rail verticale «di ripiego» per l'ospite che non lo passasse.
   * Di ospiti ce n'e' UNO (`ProjectWindow`) e lo passa sempre — quindi quel
   * ramo non lo eseguiva nessuno, ed era la TERZA presentazione della stessa
   * testata: `h-10 + border-b + bottone col solo glifo`, senza card e senza
   * nome, cioe' l'ultima copia divergente. Il tipo la chiude: chi monta questa
   * colonna deve dire dove va la sua forma chiusa.
   */
  inlineSlot: HTMLElement;
}

type SectionId = 'files' | 'git' | 'processes';

/** La colonna di partenza: 224px, cioè il vecchio `w-56` cablato. */
const DEFAULT_SIDEBAR_W = 224;
/** Sotto, l'albero dei file diventa illeggibile; sopra, mangia la finestra. */
const MIN_SIDEBAR_W = 160;
const MAX_SIDEBAR_W = 560;

/**
 * Sotto questa altezza una sezione aperta non mostra nulla: è solo chrome.
 *
 * PER SEZIONE, perché le due non hanno lo stesso chrome. Git ne ha molto:
 * misurato, 32px di intestazione + 31 della riga di commit + 67 di piede
 * (Remotes e Cronologia) = 130, prima ancora di una riga di contenuto. Col
 * vecchio minimo unico di 96 il pannello non conteneva nemmeno se stesso, e a
 * cedere era la sezione Cronologia: schiacciata a 1px sui suoi 33 naturali,
 * cioè una fessura con dentro un'intestazione tagliata. 160 = quei 130 più una
 * riga di file, che è la promessa che questo minimo fa.
 *
 * Processi non ha piede: per lui 96 resta giusto.
 */
const MIN_USEFUL_H: Record<'git' | 'processes', number> = { git: 160, processes: 96 };
/** Una riga d'albero: il pavimento di Files quando è APERTA. Chiusa non serve —
 *  lì il contenuto non c'è per scelta, e il divisore può salire fino alla card. */
const MIN_FILES_CONTENT = 24;
const DEFAULT_HEIGHTS: Record<'git' | 'processes', number> = { git: 200, processes: 150 };


/**
 * LA CARD DEL PROGETTO — una sola, per tutti e due gli stati della colonna.
 *
 * «Metti il titolo del progetto nell'apertore di sidebar progetto … e tieni la
 * stessa card per quando si apre» (Attilio, 09/08).
 *
 * Erano due cose diverse per la stessa informazione: chiusa, un bottone quadrato
 * col solo glifo (e il nome del progetto da nessuna parte); aperta, una riga a
 * tutta larghezza con un `<span>` a 12px semibold più un bottone separato in
 * coda. Due tipografie, due forme, due bersagli — per dire sempre «questo è il
 * progetto, e di qui si apre e si chiude».
 *
 * Adesso è UNA card della famiglia delle tab: stesso fondo a riposo, stesso
 * corpo, stesso incasso, stessa altezza, stesso raggio. Cambia solo il verso del
 * glifo in coda, che è l'unica cosa che cambia davvero fra i due stati.
 *
 * Il nome accessibile resta «Espandi / Nascondi la barra» perché è il gesto che
 * la card compie — ed è anche l'appiglio con cui le spec la trovano. Il nome del
 * progetto vive nel testo, che è dove si legge.
 */
function ProjectCard({
  projectPath,
  name,
  collapsed,
  onToggle,
  className = '',
  trailing,
}: {
  projectPath: string;
  name: string;
  collapsed: boolean;
  onToggle: () => void;
  className?: string;
  /**
   * The three rail commands, WHEN THEY LIVE INSIDE THIS CARD.
   *
   * They used to sit on a row of their own under the trigger (09/08, «devono
   * essere sotto il trigger sidebar progetto»), which cost the project window a
   * whole second row of chrome for three 28px buttons. Asked on 30/08 to go
   * INSIDE it instead - so the card becomes the container and the toggle
   * becomes one element within it, rather than the card being the toggle.
   *
   * A `<button>` cannot contain buttons, so when this is given the surface
   * moves OUT of the toggle and onto a wrapper: same class, same box, one row.
   */
  trailing?: React.ReactNode;
}) {
  const tr = useT();
  const etichetta = collapsed ? tr('project.sidebar.expand') : tr('project.sidebar.hide');
  // LA CARD PRENDE IL MATERIALE DELLA SUPERFICIE SU CUI GALLEGGIA.
  //
  // Collapsed it lives IN the chrome bar, in line with the tabs, and there the
  // ground is the transcript: it takes the tab surface, the one derived from
  // the design system's floating-over-content token, plus the bar's blur. Open
  // it lives in the sidebar header, on the sidebar's own fill, and there the
  // row surface is right - a tab-weight fill would read as a card sitting on a
  // card. Same component, same box, two materials because there are two
  // grounds.
  const cardCls = `group edge-lit flex items-center gap-1.5 ${ROW_PX} h-9 md:h-7 ${TAB_LABEL} ${collapsed ? `tab-glass ${TAB_RESTING_SURFACE}` : RESTING_SURFACE} rounded-lg transition-colors select-none min-w-0`;
  if (trailing) {
    return (
      <div className={`${cardCls} ${className}`} data-testid="project-card-shell">
        <button
          onClick={onToggle}
          title={`${name} · ${etichetta}`}
          aria-label={etichetta}
          aria-expanded={!collapsed}
          data-testid="project-card"
          // Surface-less: the wrapper above IS the card now. Without this the
          // toggle would paint a second fill inside the first and read as a
          // card inside a card.
          className="flex min-w-0 flex-1 items-center gap-1.5 bg-transparent cursor-pointer"
        >
          <ProjectFavicon path={projectPath} size={14} width={18} />
          <span className="truncate flex-1 text-left">{name}</span>
          {collapsed
            ? <PanelLeftOpen size={14} aria-hidden className="flex-shrink-0 text-app-text-tertiary" />
            : <PanelLeftClose size={14} aria-hidden className="flex-shrink-0 text-app-text-tertiary" />}
        </button>
        {trailing}
      </div>
    );
  }
  return (
    <button
      onClick={onToggle}
      title={`${name} · ${etichetta}`}
      aria-label={etichetta}
      aria-expanded={!collapsed}
      data-testid="project-card"
      className={`${cardCls} cursor-pointer ${className}`}
    >
      {/* L'icona c'è solo se il progetto ne spedisce una davvero: `ProjectFavicon`
          senza `fallback` non rende NIENTE e non occupa larghezza (decisione di
          prodotto, vedi il suo file). Qui va bene così: senza icona la card è il
          nome, che è già l'informazione. */}
      <ProjectFavicon path={projectPath} size={14} width={18} />
      {/* Il nome prende lo spazio, il glifo sta a DESTRA. Senza `flex-1` il
          nome si stringe sul suo testo e il glifo lo segue a ruota: da colonna
          aperta, dove la card è larga quanto la barra, finiva a mezz'aria in
          mezzo alla riga invece che sul bordo. «L'icona per richiudere la
          sidebar sia allineata a destra sul tasto dove si trova anche il titolo
          del progetto» (Attilio, 09/08). */}
      <span className="truncate flex-1 text-left">{name}</span>
      {/* I due glifi veri, non uno ruotato: `PanelLeftOpen` girato di 180 gradi
          non e `PanelLeftClose` — ribalta anche il pannello, e il verso finisce
          per dire il contrario. */}
      {collapsed
        ? <PanelLeftOpen size={14} aria-hidden className="flex-shrink-0 text-app-text-tertiary" />
        : <PanelLeftClose size={14} aria-hidden className="flex-shrink-0 text-app-text-tertiary" />}
    </button>
  );
}

/**
 * Un comando della barra di progetto CHIUSA, con la sua pastiglia.
 *
 * Su un bottone non ci sta una parola, ci sta un numero: la regola è che ne
 * porti AL PIÙ uno — pastiglia numerica oppure punto, mai entrambi — e che tutto
 * il resto (il ramo, il conteggio esteso, il perché) viva nel `title`, che è
 * l'unico posto in cui c'è spazio davvero.
 *
 * IL BOX È QUELLO DELLA RIGA, non quello del dito: sta in fila con le tab,
 * quindi la sua misura è quella della tab accanto ({@link ROW_ACTION_BOX}, 36
 * col dito e 28 col mouse). C'è stata una seconda variante — `w-7 h-7` in una
 * colonna verticale da 40px — finché la barra chiusa era una rail; non c'è più,
 * e con la rail se n'è andato anche il ramo che la disegnava.
 */
function RailButton({
  compact = false,
  icon: Icon,
  active,
  onClick,
  title,
  badge = null,
  tone = 'primary',
  dot = false,
}: {
  icon: LucideIcon;
  active: boolean;
  onClick: () => void;
  title: string;
  badge?: number | null;
  tone?: 'primary' | 'success' | 'danger';
  dot?: boolean;
  /** Inside the collapsed title card, where a row-sized box does not fit. */
  compact?: boolean;
}) {
  const toneClass = tone === 'danger'
    ? 'bg-red-500 text-white'
    : tone === 'success'
      ? 'bg-emerald-500 text-white'
      : 'bg-primary text-white';
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-expanded={active}
      // A stable anchor: the tests used to find these through the row that
      // contained them, and that row is gone.
      data-testid="project-rail-button"
      // COMPACT INSIDE THE CARD. `ROW_ACTION_BOX` is a ROW's action box (36/28):
      // it was right when these lived on a row of their own, and it fills a
      // 28px-tall card edge to edge - «devono essere piu' piccoli, seno' esce
      // brutto nel trigger» (30/08). One step down, and the card keeps its own
      // padding around them.
      className={`relative ${compact ? 'w-6 h-6 md:w-5 md:h-5' : ROW_ACTION_BOX} flex items-center justify-center rounded-md edge-lit transition-colors flex-shrink-0 ${
        active ? 'text-primary bg-primary/10' : `${RAISED_CONTROL} text-app-text`
      }`}
    >
      <Icon size={compact ? 13 : 16} />
      {/* LA PASTIGLIA STA IN BASSO, e senza anello.
          Stava a `-top-1`, cioè un pixel SOPRA il bottone. Finché la riga era
          alta 40 e il bottone centrato, quel pixel cadeva dentro i 6 di aria; da
          quando la riga subordinata è 34 con il contenuto a filo in cima (vedi
          CHROME_BAR_SUB) cade a y=39 contro una scatola che comincia a 40, e
          l'`overflow-hidden` della barra lo taglia. In basso invece c'è
          l'incasso in coda: 68+4 = 72 dentro una scatola che finisce a 74.
          «I contatori vengono tagliati dalla top bar; li potremmo mettere verso
          il basso, e senza un bordo extra bianco intorno» (Attilio, 09/08).
          L'anello serviva a staccare la pastiglia dal TRATTO dell'icona quando
          le stava sopra: sull'angolo basso non ha più niente da attraversare, e
          un cerchio chiaro attorno a un numero colorato è una terza cosa che non
          dice niente. */}
      {badge !== null && badge > 0 && (
        <span className={`absolute -bottom-1 -right-1 min-w-[15px] h-[15px] px-[3px] flex items-center justify-center rounded-full text-[9px] font-bold leading-none tabular-nums ${toneClass}`}>
          {badge > 99 ? '99+' : badge}
        </span>
      )}
      {badge === null && dot && (
        <span className={`absolute -bottom-0.5 -right-0.5 w-[7px] h-[7px] rounded-full ${toneClass}`} />
      )}
    </button>
  );
}

export function ProjectSidebar({
  projectPath,
  displayName,
  collapsed,
  onToggleCollapse,
  onOpenFile,
  onWSMessage,
  onOpenProcessLog,
  inlineSlot,
}: ProjectSidebarProps) {
  const tr = useT();
  // I quattro comandi dell'intestazione «Files» (nuovo file, nuova cartella,
  // chiudi tutto, ricarica) non hanno un altro percorso col dito, e sono UNO
  // per pannello — non uno per riga —, quindi senza puntatore si vedono
  // (`touch: 'shown'`) invece di restare bersagli invisibili sull'header.
  const filesHeaderReveal = useHoverReveal('files', { touch: 'shown' });
  // Project name = the display override (task title) or the path's folder name.
  const projectName = displayName || projectPath.split('/').filter(Boolean).pop() || 'Project';
  // Auto-collapse on mobile
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const h = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);

  /**
   * Apertura delle sezioni, larghezza della colonna e altezze del fondo: dove
   * vivono, e perche' hanno cambiato casa.
   *
   * Stavano in `sessionStorage`, senza nessuna ragione scritta. Il guaio e' che
   * `sessionStorage` muore con la SCHEDA: una seconda finestra, un pop-out di
   * un topic, una scheda nuova ripartivano tutti dal default, e la colonna che
   * avevi stretto per quell'albero di file tornava larga. Misurato il
   * 20/08/2026 (`refresh-durability-board.spec.ts`, riga 7): stessa scheda
   * ricaricata -> resta; scheda nuova -> default.
   *
   * L'equivalente nella sidebar principale (`sidebar-collapsed-groups` in
   * `TopicTree`) sta in `localStorage` da sempre. Era una disparita' per caso,
   * non una scelta: due stati della stessa natura, con due durate diverse.
   *
   * La lettura ricade su `sessionStorage` una volta sola, cosi' una finestra
   * aperta adesso non perde cio' che ci aveva messo dentro; la scrittura va
   * solo in `localStorage`, quindi la vecchia casa si svuota da se'.
   */
  const readLayout = (k: string): string | null => {
    try {
      return localStorage.getItem(k) ?? sessionStorage.getItem(k);
    } catch { return null; }
  };
  const writeLayout = (k: string, v: string): void => {
    try { localStorage.setItem(k, v); } catch { /* quota o storage negato: si resta col default */ }
  };

  // On mobile, start collapsed but allow toggling (renders as overlay)
  const effectiveCollapsed = collapsed;
  // Le chiavi portano il PROGETTO. Erano globali — `sidebar-sections` e
  // `project-sidebar-bottom-heights` secche — quindi due progetti affiancati si
  // scambiavano apertura e altezze, e ciò che avevi stretto su uno arrivava
  // stretto sull'altro senza averlo mai toccato lì.
  const SECTIONS_KEY = `sidebar-sections:${projectPath}`;
  // `:auto` e non la chiave vecchia: là dentro ci sono NUMERI nati dal default,
  // non da una scelta dell'utente. Onorarli terrebbe tutti sull'altezza fissa
  // per sempre, cioè esattamente ciò che stiamo togliendo.
  const HEIGHTS_KEY = `project-sidebar-bottom-heights:auto:${projectPath}`;
  const [expandedSections, setExpandedSections] = useState<Record<SectionId, boolean>>(() => {
    try {
      const saved = readLayout(SECTIONS_KEY) ?? sessionStorage.getItem('sidebar-sections');
      if (saved) return JSON.parse(saved);
    } catch {}
    return { files: true, git: false, processes: false };
  });

  // Persist expanded sections across page refreshes
  useEffect(() => {
    writeLayout(SECTIONS_KEY, JSON.stringify(expandedSections));
  }, [SECTIONS_KEY, expandedSections]);

  const fileExplorerRef = useRef<FileExplorerHandle>(null);

  // Running process count for the Processes header badge (shared hook — no duplicate polling)
  const { scripts, runningCount } = useScripts({ projectPath, onMessage: onWSMessage });
  // La regola del «fallimento vero» sta in `lib/processFailure`, condivisa con
  // la lista dei processi: due copie della stessa soglia divergono al primo che
  // la tocca.
  const failedCount = scripts.filter(sp => isRecentFailure(sp)).length;

  // Stato git — dalla sidebar, non dal pannello. È questa la superficie che
  // sopravvive al collasso: GitChanges è lazy e SMONTATO quando la sezione è
  // chiusa, quindi se i numeri della rail dipendessero da lui sarebbero fermi
  // all'ultima volta che qualcuno ha aperto il pannello. Qui c'è anche l'unico
  // punto dell'albero che ha in mano `onWSMessage`: passarlo accende il push
  // `git:status` del watcher server-side per TUTTI i consumer del progetto
  // (store condiviso in useGitStatus), pannello e decorazioni dei file inclusi.
  const { gitStatus, notGit } = useGitStatus({ projectPath, onMessage: onWSMessage });
  const git = gitStatus && !notGit
    ? { branch: gitStatus.branch, fileCount: gitStatus.files?.length ?? 0, ahead: gitStatus.ahead ?? 0, behind: gitStatus.behind ?? 0 }
    : null;
  // NOTHING CHANGED, NOTHING ON SCREEN. A section headed "git changes" with a
  // count of zero spends a row to say that nothing happened, and the same row
  // in the collapsed rail. It comes back by itself at the first change, at the
  // first commit not pushed, at the first commit behind the upstream: the
  // condition is live, not a one-off read at mount.
  const gitVisible = hasGitStateToShow(git);

  const toggleSection = (section: SectionId) => {
    setExpandedSections(prev => {
      const opening = !prev[section];
      // Aprire una sezione deve SEMPRE mostrare qualcosa. Git e Processi hanno
      // un'altezza in pixel salvata, e il minimo di trascinamento era 32px —
      // cioè esattamente l'altezza dell'intestazione: una sezione stretta fin
      // laggiù si «apriva» su zero pixel di contenuto e sembrava rotta (il
      // chevron ruotava e non compariva niente). Se l'altezza salvata non
      // lascia spazio, si riapre alla misura di partenza.
      if (opening && (section === 'git' || section === 'processes')) {
        setBottomHeights(h => {
          // `null` = altezza automatica: è già utile per costruzione, non c'è
          // niente da sbloccare. Il cancello serve solo a chi ha un'altezza
          // FISSA trascinata così stretta da non contenere più niente.
          const a = h[section];
          if (a === null || a >= MIN_USEFUL_H[section]) return h;
          return { ...h, [section]: DEFAULT_HEIGHTS[section] };
        });
      }
      return { ...prev, [section]: opening };
    });
  };

  // ── Larghezza della barra ────────────────────────────────────────────────
  // Per progetto, come apertura e altezze: un albero di file profondo e uno
  // piatto non vogliono la stessa colonna, e la misura giusta è quella che hai
  // scelto lì.
  const WIDTH_KEY = `project-sidebar-width:${projectPath}`;
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = readLayout(WIDTH_KEY);
      const n = saved ? parseInt(saved, 10) : NaN;
      if (Number.isFinite(n)) return Math.min(MAX_SIDEBAR_W, Math.max(MIN_SIDEBAR_W, n));
    } catch {}
    return DEFAULT_SIDEBAR_W;
  });
  useEffect(() => {
    writeLayout(WIDTH_KEY, String(sidebarWidth));
  }, [WIDTH_KEY, sidebarWidth]);

  // ── Bottom sections (Git, Processes) — ancorate in fondo, altezza AUTOMATICA ──
  //
  // `null` vuol dire «la decide il contenuto» (col tetto di `capSezione`), un
  // numero vuol dire «l'ho decisa io trascinando». È la distinzione che prima
  // non c'era: l'altezza era SEMPRE un numero, quindi non si poteva sapere se
  // veniva da una scelta dell'utente o dal valore con cui era nata, e l'unica
  // risposta possibile era tenerla ferma per sempre.
  //
  // Il trascinamento resta, ed è una DEROGA esplicita: chi tira il divisore sta
  // dicendo «questa la voglio così», e da lì in poi la sezione non si adatta
  // più. Doppio clic sul divisore torna all'automatico — stessa convenzione del
  // divisore della larghezza, che col doppio clic torna al default.
  const [bottomHeights, setBottomHeights] = useState<Record<'git' | 'processes', number | null>>(() => {
    try {
      const saved = readLayout(HEIGHTS_KEY);
      if (saved) return JSON.parse(saved);
    } catch {}
    return { git: null, processes: null };
  });

  useEffect(() => {
    writeLayout(HEIGHTS_KEY, JSON.stringify(bottomHeights));
  }, [HEIGHTS_KEY, bottomHeights]);

  const widthDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Un divisore ha SEMPRE un sotto e un sopra, e alzarlo fa crescere quello
  // SOTTO: la colonna è ancorata in fondo (Files prende ciò che avanza, Git e
  // Processi hanno un'altezza in pixel). Il campo si chiamava `section` e non
  // diceva da che parte stesse, così il divisore Git↔Processi passava `git` —
  // cioè quello SOPRA — e il trascinamento usciva rovesciato.
  //
  // `above` assente = il vicino di sopra è Files, che non ha un'altezza sua:
  // assorbe con `flex-1`, e il fermo è quanto le resta da cedere (`slack`).
  const dragRef = useRef<{
    below: 'git' | 'processes';
    above?: 'git' | 'processes';
    startY: number;
    startBelow: number;
    startAbove?: number;
    slack: number;
  } | null>(null);

  // Files non ha un'altezza in stato: quanto può cedere si MISURA quando parte
  // il trascinamento. Da una costante non si potrebbe — la sua intestazione è
  // una card e cambia altezza col breakpoint.
  const filesBoxRef = useRef<HTMLDivElement>(null);
  /** Le scatole di Git e Processi, per misurarne l'altezza VERA quando è
   *  automatica (vedi `startBottomResize`). Un oggetto e non due ref separate:
   *  chi trascina le indicizza per nome. */
  const sectionsRef = useRef<Record<'git' | 'processes', HTMLDivElement | null>>({ git: null, processes: null });
  const filesHeaderRef = useRef<HTMLDivElement>(null);

  // Full-viewport drag chrome (same protocol as useGridResize): keeps the
  // pointer out of iframes in the main area mid-drag and lets native Electron
  // WebContentsView panes hide via pane-resize-start/end. Raised lazily on
  // the first real movement so a bare click never retargets its mouseup.
  const dragOverlay = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // 32px era l'altezza dell'INTESTAZIONE: si poteva trascinare una sezione
    // fino a farla sparire del tutto e poi non c'era modo di capire perché
    // «non si apriva». Il minimo lascia sempre una riga di contenuto.
    const minDi = (s: 'git' | 'processes') => MIN_USEFUL_H[s];
    const dropChrome = () => {
      if (dragOverlay.current) {
        dragOverlay.current.remove();
        dragOverlay.current = null;
        window.dispatchEvent(new Event('topics:pane-resize-end'));
      }
    };
    // Il velo a tutto schermo è lo STESSO delle altre resize (useGridResize):
    // tiene il puntatore fuori dagli iframe e dalle pane native mentre trascini,
    // e si alza solo al primo movimento vero, così un click secco non si
    // ritrova il mouseup su un altro bersaglio.
    const raiseChrome = (cursor: 'row-resize' | 'col-resize') => {
      if (dragOverlay.current) return;
      const ov = document.createElement('div');
      ov.style.cssText = `position:fixed;inset:0;z-index:2147483647;cursor:${cursor}`;
      document.body.appendChild(ov);
      dragOverlay.current = ov;
      window.dispatchEvent(new Event('topics:pane-resize-start'));
    };
    const onMove = (e: MouseEvent) => {
      const w = widthDragRef.current;
      if (w) {
        if ((e.buttons & 1) === 0) { onUp(); return; }
        const dx = e.clientX - w.startX;
        if (!dragOverlay.current && Math.abs(dx) <= DRAG_SLOP_PX) return;
        raiseChrome('col-resize');
        setSidebarWidth(Math.min(MAX_SIDEBAR_W, Math.max(MIN_SIDEBAR_W, w.startWidth + dx)));
        return;
      }
      const r = dragRef.current;
      if (!r) return;
      // Lost-mouseup recovery: button no longer down — end the drag.
      if ((e.buttons & 1) === 0) { onUp(); return; }
      const delta = e.clientY - r.startY;
      if (!dragOverlay.current && Math.abs(delta) <= DRAG_SLOP_PX) return;
      raiseChrome('row-resize');
      // Si stringe il DELTA, non le due altezze una per una. Tagliandole a
      // valle con due `Math.max` indipendenti la somma non si conserva: quando
      // una tocca il suo minimo l'altra continua a crescere, la coppia sfonda
      // la colonna e il tetto — cioè il fondo di Files — se ne va per i fatti
      // suoi. Misurato: tirando a fondo corsa la coppia passava da 350 a 696.
      // I MINIMI SONO PAVIMENTI PER CHI SI STRINGE, MAI OBIETTIVI PER CHI CRESCE.
      //
      // Da quando l'altezza è automatica una sezione può stare SOTTO il suo
      // `MIN_USEFUL_H` in modo del tutto legittimo: il minimo nasce per impedire
      // che la si TRASCINI fino a non mostrare più niente, non per pretendere
      // che una sezione con poco contenuto si gonfi. Senza il taglio a zero,
      // `minDi(above) - startAbove` diventava POSITIVO — «il vicino deve
      // crescere di 42 per arrivare al suo minimo» — e vinceva su un delta
      // negativo: il divisore SCENDEVA di 42 mentre lo tiravi su. Misurato,
      // RESIZE-1: 631,75 → 674.
      //
      // Con i due `Math`, chi è già sotto il proprio minimo semplicemente non ha
      // più niente da cedere (margine zero) e il gesto resta nel verso giusto.
      const giu = Math.max(0, r.startBelow - minDi(r.below)); // quanto si può scendere
      const su = r.above !== undefined
        ? Math.min(0, minDi(r.above) - r.startAbove!)         // fin dove cede il vicino
        : -r.slack;                                           // fin dove cede Files
      const d = su > giu ? 0 : Math.min(giu, Math.max(su, delta));
      // Alzare il divisore (d < 0) fa crescere ciò che gli sta SOTTO.
      setBottomHeights(prev => r.above
        ? { ...prev, [r.below]: r.startBelow - d, [r.above]: r.startAbove! + d }
        : { ...prev, [r.below]: r.startBelow - d });
    };
    const onUp = () => {
      if (!dragRef.current && !widthDragRef.current) return;
      dragRef.current = null;
      widthDragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      dropChrome();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // Unmount mid-drag: balance the pane-resize-start already dispatched.
      dragRef.current = null;
      widthDragRef.current = null;
      dropChrome();
    };
  }, []);

  const startWidthResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    widthDragRef.current = { startX: e.clientX, startWidth: sidebarWidth };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [sidebarWidth]);

  /** Doppio click sul bordo: torna alla misura di partenza. */
  const resetWidth = useCallback(() => {
    widthDragRef.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    setSidebarWidth(DEFAULT_SIDEBAR_W);
  }, []);

  /**
   * `below` è la sezione SOTTO il divisore: è quella che cresce tirando in su.
   * `above` è il vicino di sopra quando ne ha uno con un'altezza sua; senza,
   * il vicino è Files e il fermo lo dà `slack`.
   */
  /**
   * Doppio clic su un divisore: le sezioni che governa tornano AUTOMATICHE.
   *
   * È il gemello di `resetWidth` sul bordo destro della colonna, e serve perché
   * il trascinamento è una deroga senza scadenza: una volta tirato, quel
   * pannello non si adatta più al contenuto e non c'era modo di dirgli
   * «ricomincia ad adattarti» — se non ricaricando la finestra.
   */
  const resetBottomAuto = useCallback((...sezioni: ('git' | 'processes')[]) => () => {
    setBottomHeights(h => {
      const next = { ...h };
      for (const s of sezioni) next[s] = null;
      return next;
    });
  }, []);

  const startBottomResize = useCallback((below: 'git' | 'processes', above?: 'git' | 'processes') => (e: React.MouseEvent) => {
    e.preventDefault();
    // Quanto Files può ancora cedere: la sua scatola meno ciò che deve restare
    // visibile. Aperta lascia almeno una riga d'albero, chiusa basta la card —
    // è lo stesso principio del minimo di Git e Processi, che non si stringono
    // mai fino a diventare la sola intestazione.
    const box = filesBoxRef.current?.offsetHeight ?? 0;
    const testa = filesHeaderRef.current?.offsetHeight ?? 0;
    const pavimento = testa + (expandedSections.files ? MIN_FILES_CONTENT : 0);
    // L'ALTEZZA DI PARTENZA SI MISURA, non si legge dallo stato: da automatica lo
    // stato dice `null` — è il contenuto a decidere — e un trascinamento che
    // partisse da lì salterebbe di colpo al primo numero. Si legge il pixel che
    // c'è adesso sullo schermo, che è anche quello che l'utente sta afferrando.
    const realHeight = (sez: 'git' | 'processes') =>
      bottomHeights[sez] ?? sectionsRef.current[sez]?.offsetHeight ?? DEFAULT_HEIGHTS[sez];
    const partenzaSotto = realHeight(below);
    const partenzaSopra = above ? realHeight(above) : undefined;
    // E SI FISSANO SUBITO, prima che il gesto cominci.
    //
    // Il primo taglio le misurava e basta, lasciando lo stato su `null` finché
    // il primo movimento non scriveva un numero. In mezzo c'era un fotogramma in
    // cui `startBelow` era l'altezza MISURATA mentre l'elemento si disegnava
    // ancora in automatico: due verità per la stessa scatola, e la sottrazione
    // del delta partiva da quella sbagliata. Misurato: il divisore SCENDEVA di
    // 42px mentre lo tiravi su (RESIZE-1).
    //
    // Materializzando qui, dal primo fotogramma il rendering e l'aritmetica
    // guardano lo stesso numero — ed è anche il momento giusto perché è
    // esattamente quando l'utente prende il divisore che smette di volere
    // l'automatico.
    setBottomHeights(h => {
      const next = { ...h };
      if (h[below] === null) next[below] = partenzaSotto;
      if (above && h[above] === null) next[above] = partenzaSopra!;
      return next;
    });
    dragRef.current = {
      below,
      above,
      startY: e.clientY,
      startBelow: partenzaSotto,
      startAbove: partenzaSopra,
      slack: Math.max(0, box - pavimento),
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, [bottomHeights, expandedSections.files]);

  if (effectiveCollapsed) {
    const open = (section: SectionId) => () => {
      onToggleCollapse();
      // Stesso cancello del toggle: una sezione stretta a zero deve tornare
      // utile anche quando la si apre dalla rail, non solo dall'intestazione.
      if (section === 'git' || section === 'processes') {
        setBottomHeights(h => {
          // `null` = altezza automatica: è già utile per costruzione, non c'è
          // niente da sbloccare. Il cancello serve solo a chi ha un'altezza
          // FISSA trascinata così stretta da non contenere più niente.
          const a = h[section];
          if (a === null || a >= MIN_USEFUL_H[section]) return h;
          return { ...h, [section]: DEFAULT_HEIGHTS[section] };
        });
      }
      setExpandedSections(prev => ({ ...prev, [section]: true }));
    };
    // Tooltip: è QUI che sta l'informazione lunga. Nella rail ci sono 40px, e
    // il numero da solo dice «c'è qualcosa», non «cosa». Il titolo completa.
    const plural = (key: string, n: number) =>
      n === 1 ? tr(`${key}.one`) : tr(`${key}.many`, { n });
    const gitTitle = git
      ? [
          `${tr('project.sidebar.gitChanges')} · ${git.branch}`,
          git.fileCount > 0
            ? plural('project.sidebar.changedFiles', git.fileCount)
            : tr('project.sidebar.clean'),
          [git.ahead > 0 ? `↑${git.ahead}` : '', git.behind > 0 ? `↓${git.behind}` : '']
            .filter(Boolean).join(' '),
        ].filter(Boolean).join('\n')
      : tr('project.sidebar.gitChanges');
    const procTitle = failedCount > 0
      ? `${tr('project.sidebar.processes')}\n${plural('project.sidebar.processesFailed', failedCount)}`
      : runningCount > 0
        ? `${tr('project.sidebar.processes')}\n${plural('project.sidebar.processesRunning', runningCount)}`
        : tr('project.sidebar.processes');
    // I TRE COMANDI, in un posto solo. Sono nati come coppia — una lista per la
    // rail verticale e una per la striscia in linea — e la rail non c'e' piu':
    // resta la lista, che e' anche il motivo per cui non ne sono mai divergite
    // due al primo badge aggiunto.
    const comandi = () => (
      <>
        <RailButton
          compact
          icon={FolderTree}
          active={expandedSections.files}
          onClick={open('files')}
          title={tr('project.sidebar.files')}
        />
        {gitVisible && <RailButton
          compact
          icon={GitBranch}
          active={expandedSections.git}
          onClick={open('git')}
          title={gitTitle}
          // Il NOME DEL RAMO non entra e non ci va: nei tool seri il ramo vive
          // nella status bar. Qui ci va il numero che VS Code mette sulla stessa
          // icona — quante modifiche non committate — e il ramo sta nel
          // tooltip, per intero.
          badge={git && git.fileCount > 0 ? git.fileCount : null}
          tone="primary"
          // Nessuna modifica ma divergenza col remoto: un punto, non un secondo
          // numero addosso al primo. Due pastiglie su un bottone da 28px
          // diventano rumore e non si leggono più né l'una né l'altra.
          dot={!!git && git.fileCount === 0 && (git.ahead > 0 || git.behind > 0)}
        />}
        <RailButton
          compact
          icon={CirclePlay}
          active={expandedSections.processes}
          onClick={open('processes')}
          title={procTitle}
          // Il rosso è il motivo per cui questo badge esiste: un processo uscito
          // male, oggi, non lo vedi da nessuna parte se la sidebar è chiusa.
          // Vince sul verde perché è l'unico dei due che chiede di fare
          // qualcosa.
          badge={failedCount > 0 ? failedCount : runningCount > 0 ? runningCount : null}
          tone={failedCount > 0 ? 'danger' : 'success'}
        />
      </>
    );

    // ANCHE COL DITO, e ci si arriva togliendo il nome. Con la card del titolo
    // la striscia faceva ~330px su uno schermo da 390: la barra intera, senza
    // più posto per le tab, e per questo il primo taglio la teneva spenta sul
    // telefono. Senza nome sono quattro box da 36 con 6 di aria — ~160px — e
    // «sulla versione mobile anche doveva essere aggiornata» (Attilio, 09/08)
    // diventa una cosa che ci sta.
    const striscia = createPortal(
        <div
          data-testid="project-rail-inline"
          // In fila con le tab e con la loro grammatica: `gap-0.5` come fra due
          // tab, `pl-1.5` cioè ROW_INSET dal bordo della riga. NIENTE filo di
          // separazione verso le tab — in questa colonna una linea fra card
          // ripete ciò che fondo e distanza dicono già (è la regola di
          // `selectionStyles`), ed era proprio la linea di troppo da togliere.
          // NON `flex-shrink-0`: con molte tab aperte qualcosa deve cedere, e a
          // cedere dev'essere il NOME (che tronca), non i comandi (che
          // sparirebbero). I bottoni sono `flex-shrink-0` da soli, quindi la
          // pressione arriva tutta sulla card del titolo.
          className={`flex items-center ${TAB_GAP_CLASS} pl-1.5 min-w-0 app-no-drag`}
          {...NO_DRAG_REGION}
        >
          {/* IL NOME STA DENTRO L'APERTORE, non accanto a lui.
              C'è stato un giro con due card — un bottone quadrato per aprire e
              una card col nome accanto — e Attilio ha tolto la seconda: due
              card a 6px di distanza per dire la stessa cosa. La forma giusta
              era una sola: il titolo È il bottone che apre. */}
          {/* I TRE COMANDI STANNO DENTRO LA CARD, non su una riga sotto.
              Erano sotto dal 09/08, e la riga sotto costava alla finestra di
              progetto una fascia di chrome intera per tre bottoni da 28px.
              Chiesto il 30/08 di portarli dentro il trigger: una card sola, in
              fila con le tab, che contiene il nome e i comandi. */}
          <ProjectCard
            projectPath={projectPath}
            name={projectName}
            collapsed
            onToggle={onToggleCollapse}
            className="max-w-[280px] flex-shrink"
            trailing={comandi()}
          />
        </div>,
        inlineSlot,
    );

    return striscia;
  }

  // On mobile: render as overlay on top of content.
  // Su PORTALE, per lo stesso motivo del modale delle impostazioni: la sidebar
  // vive dentro la pane progetto, e il guscio delle pane ha `contain: layout`
  // (vedi PaneKeepAlive). Un containing block in mezzo trasformerebbe questo
  // drawer a tutta altezza in un riquadro grande quanto la pane. Il portale lo
  // riporta ad ancorarsi al viewport.
  if (isMobile) {
    return createPortal(
      <>
        <div className="fixed inset-0 bg-black/50 z-40" onClick={onToggleCollapse} aria-hidden="true" />
        <div
          // Stessa ancora della variante desktop: le due non convivono mai (il
          // ramo è esclusivo), e portare lo stesso nome fa sì che la ritaratura
          // dei token del chrome in index.css — agganciata a QUESTO selettore —
          // valga anche sul telefono, dove il fondo è identico.
          data-testid="project-sidebar"
          className="chrome-glass fixed inset-y-0 left-0 z-50 w-[280px] bg-app-chrome flex flex-col overflow-hidden shadow-lg"
          // IL FONDO SI FERMA SOPRA L'HOME INDICATOR. Il pannello è
          // `inset-y-0`, quindi la sua ultima riga finiva sotto il trattino:
          // uno spazio da cui non si può toccare niente, occupato da qualcosa
          // di toccabile. Il padding lo dipinge il background di QUESTO
          // elemento, quindi la fascia esce del colore del chrome e il bordo
          // dell'app resta continuo — il contenuto sale, la superficie no. È lo
          // stesso rimedio del composer (ChatInput) e della barra di stato
          // della sidebar principale.
          style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
        >
          {/* Header */}
          {/* LA STESSA CARD DELLA BARRA CHIUSA. Era un `<span>` a 12px semibold
              piu un bottone separato in coda: due elementi, due tipografie, per
              dire cio che la card dice in uno. Niente `border-b`: sotto c'e la
              card, e in questa colonna una linea ripete cio che fondo e
              distanza dicono gia. L'incasso e ROW_INSET come ogni altra card. */}
          <div className="flex items-center h-10 px-1.5 flex-shrink-0">
            <ProjectCard projectPath={projectPath} name={projectName} collapsed={false} onToggle={onToggleCollapse} className="flex-1" />
          </div>
          {/* Sections — Files fills top, Git/Processes anchored at bottom (vedi il
              gemello desktop per il mezzo passo in fondo). */}
          {/* `sidebar-column`: la PRIMA card non porta il suo mezzo passo in cima.
          L'intestazione chiude già con `md:pb-[6px]` — il passo pieno — e la
          card sotto ci aggiungeva i suoi 3, facendo 9 dove ne servono 6.
          «Doppia spaziatura fra trigger, Files e tabbar» (Attilio, 09/08). La
          regola è la stessa della colonna principale (index.css), non una
          seconda: due posti che dicono la stessa cosa divergono al primo che
          viene corretto da solo. */}
      <div className="flex-1 flex flex-col min-h-0 pb-[3px] sidebar-column">
            <div className={`flex flex-col ${expandedSections.files ? 'flex-1 min-h-0 pb-[3px]' : 'flex-shrink-0'}`}>
              <div
                onClick={() => toggleSection('files')}
                // Stessa ancora della variante desktop qui sotto.
                data-testid="project-sidebar-files"
                role="button"
                aria-expanded={expandedSections.files}
                className={`${SECTION_CARD} group/files`}
              >
                <FolderTree size={14} className="flex-shrink-0" />
                <span>{tr('project.sidebar.files')}</span>
                <ChevronRight size={12} className={`transition-transform duration-150 text-app-text-tertiary flex-shrink-0 ${expandedSections.files ? 'rotate-90' : ''}`} />
                {expandedSections.files && (
                  <div className={`ml-auto flex items-center gap-0.5 ${filesHeaderReveal}`} onClick={e => e.stopPropagation()}>
                    <button onClick={() => fileExplorerRef.current?.newFile()} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary" title={tr('project.sidebar.newFile')}><FilePlus size={12} /></button>
                    <button onClick={() => fileExplorerRef.current?.newFolder()} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary" title={tr('project.sidebar.newFolder')}><FolderPlus size={12} /></button>
                    <button onClick={() => fileExplorerRef.current?.collapseAll()} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary" title={tr('project.sidebar.collapseAll')}><ChevronsDownUp size={12} /></button>
                    <button onClick={() => fileExplorerRef.current?.refresh()} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary" title={tr('project.sidebar.refresh')}><RefreshCw size={12} /></button>
                  </div>
                )}
              </div>
              {expandedSections.files && (
                <div className="flex-1 min-h-0 overflow-y-auto">
                  <FileExplorer ref={fileExplorerRef} projectPath={projectPath} compact onOpenFile={onOpenFile} onWSMessage={onWSMessage} />
                </div>
              )}
            </div>
            {gitVisible && <div
              data-testid="project-sidebar-git-section"
              ref={el => { sectionsRef.current.git = el; }}
              className={`flex flex-col overflow-hidden ${expandedSections.git ? 'min-h-0 pb-[3px]' : 'flex-shrink-0'}`}
              style={expandedSections.git
              // Automatica: l'altezza la dà il contenuto, con il tetto di
              // `capSezione`. Trascinata: il numero vince, ed è una deroga
              // esplicita — chi ha tirato il divisore ha detto «così».
              ? (bottomHeights.git === null
                  // Fra il MINIMO UTILE e il tetto: «si adatta al contenuto»
                  // non vuol dire «può diventare una fessura». Il pavimento
                  // è quello che già esisteva per il trascinamento
                  // (`MIN_USEFUL_H`), ed è per sezione perché il chrome delle
                  // due è diverso: sotto quella misura il pannello non
                  // conterrebbe nemmeno se stesso.
                  ? { minHeight: MIN_USEFUL_H.git, maxHeight: capSezione() }
                  : { height: bottomHeights.git })
              : undefined}
            >
              <Suspense fallback={
                <div onClick={() => toggleSection('git')} className={SECTION_CARD}>
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <GitBranch size={14} className={`flex-shrink-0 ${git ? '' : 'text-app-text-muted'}`} />
                    <span>{tr('project.sidebar.gitChanges')}</span>
                    <ChevronRight size={12} className={`flex-shrink-0 transition-transform duration-150 text-app-text-tertiary ${expandedSections.git ? 'rotate-90' : ''}`} />
                  </div>
                </div>
              }>
                <GitChanges projectPath={projectPath} compact expanded={expandedSections.git} onToggle={() => toggleSection('git')} />
              </Suspense>
            </div>}
            <div
              ref={el => { sectionsRef.current.processes = el; }}
              className={`flex flex-col overflow-hidden ${expandedSections.processes ? 'min-h-0 pb-[3px]' : 'flex-shrink-0'}`}
              style={expandedSections.processes
              // Automatica: l'altezza la dà il contenuto, con il tetto di
              // `capSezione`. Trascinata: il numero vince, ed è una deroga
              // esplicita — chi ha tirato il divisore ha detto «così».
              ? (bottomHeights.processes === null
                  // Fra il MINIMO UTILE e il tetto: «si adatta al contenuto»
                  // non vuol dire «può diventare una fessura». Il pavimento
                  // è quello che già esisteva per il trascinamento
                  // (`MIN_USEFUL_H`), ed è per sezione perché il chrome delle
                  // due è diverso: sotto quella misura il pannello non
                  // conterrebbe nemmeno se stesso.
                  ? { minHeight: MIN_USEFUL_H.processes, maxHeight: capSezione() }
                  : { height: bottomHeights.processes })
              : undefined}
            >
              <button
                onClick={() => toggleSection('processes')}
                // Ancora stabile per chi guarda da fuori: l'etichetta è tradotta
                // dal 9d1991ea («Multilingua: terzo lotto»), quindi il testo non
                // è un appiglio. E il bottone è un TOGGLE: `aria-expanded` è
                // l'unico modo di aprirlo senza rischiare di richiuderlo — il
                // gemello nella rail lo dichiara già (RailButton).
                data-testid="project-sidebar-processes"
                aria-expanded={expandedSections.processes}
                className={SECTION_CARD}
              >
                <CirclePlay size={14} className="flex-shrink-0" />
                <span>{tr('project.sidebar.processes')}</span>
                <ChevronRight size={12} className={`transition-transform duration-150 text-app-text-tertiary flex-shrink-0 ${expandedSections.processes ? 'rotate-90' : ''}`} />
                {runningCount > 0 && (
                  <span className="ml-auto text-[11px] font-medium text-green-600 dark:text-green-400 bg-green-500/10 px-1.5 py-[1px] rounded-full">
                    {runningCount}
                  </span>
                )}
              </button>
              {expandedSections.processes && (
                <div className="flex-1 min-h-0 overflow-y-auto">
                  <ScriptRunner projectPath={projectPath} onOpenProcessLog={onOpenProcessLog} />
                </div>
              )}
            </div>
          </div>
        </div>
      </>,
      document.body,
    );
  }

  return (
    <div
      data-testid="project-sidebar"
      // `bg-app-chrome`, non `bg-elevated`. Misurato in tema chiaro sul web:
      // questa colonna usciva #fafafa mentre la sidebar principale — l'altro
      // chrome della stessa finestra — usciva #eaecf0, e la pagina sotto è
      // #f8f9fa. Cioè la barra dei progetti era la superficie più CHIARA delle
      // tre: avanzava verso l'occhio invece di arretrare, al contrario di ogni
      // altro chrome («non mi sembra che abbia lo sfondo corretto rispetto al
      // tema», Attilio 08/08). La classe `chrome-glass` c'era già, ma sotto
      // Tauri/mac è l'unica cosa che dipinge: sul web e su Windows/Linux
      // restava `bg-elevated` a decidere, e nessuno lo vedeva dal Mac.
      //
      // Nessun rischio di doppia mano: la guardia anti-compounding è agganciata
      // alla CLASSE (`.chrome-glass .chrome-glass { transparent !important }`),
      // e sotto la shell il `!important` di quelle regole batte comunque questa
      // utility. Qui si corregge il ramo che la shell non attraversa.
      // IL FILO TORNA, ed è la stessa conclusione della sidebar principale: da
      // quando il velo è uno solo, colonna e contenuto hanno lo stesso pixel, e
      // due zone dello stesso piano le separa un filo — non un'ombra, non una
      // differenza di tinta che non c'è più. «Mostriamo bordo sidebar, mi sa non
      // abbiamo altre soluzioni pulite» (Attilio, 09/08): non è un ripiego, è
      // l'unica cosa che resta quando le due superfici sono identiche.
      className="chrome-glass flex-shrink-0 bg-app-chrome border-r border-app-border flex flex-col overflow-hidden relative"
      style={{ width: sidebarWidth }}
    >
      {/* Maniglia sul bordo destro: invisibile, si annuncia col cursore.
          Colorarla al passaggio dava al bordo della barra un aspetto diverso da
          ogni altro bordo solo perche e trascinabile, e la barra non e un
          controllo.
          Sta dentro la barra (`right-0`), non fuori: la barra ha
          `overflow-hidden`, quindi una maniglia che sporge viene ritagliata per
          meta, resta visibile e non prende il mouse. */}
      <div
        data-testid="project-sidebar-resizer"
        onMouseDown={startWidthResize}
        onDoubleClick={resetWidth}
        title={tr('project.sidebar.resize')}
        className="absolute top-10 md:top-[34px] bottom-0 right-0 w-2 z-20 cursor-col-resize"
      />
      {/* Header — height matches the pane tab bar (h-10) */}
      {/* LA STESSA CARD DELLA BARRA CHIUSA — vedi ProjectCard. E la STESSA RIGA
          della barra delle tab che le sta accanto, quindi ne segue la geometria
          alla lettera: sopra i 768px la riga subordinata e alta 34 con l'incasso
          solo sotto (CHROME_BAR_SUB), perche l'aria in cima l'ha gia messa la
          barra dell'app. Se questa testata restasse `h-10`, la card e la prima
          sotto-tab si scollerebbero di sei pixel — e sarebbero due meta della
          stessa riga. */}
      <div className="flex items-center h-10 md:h-[34px] md:pb-[6px] px-1.5 flex-shrink-0">
        <ProjectCard projectPath={projectPath} name={projectName} collapsed={false} onToggle={onToggleCollapse} className="flex-1" />
      </div>

      {/* Sections — Files fills top (flex-1), Git/Processes anchored at bottom.
          IL MEZZO PASSO IN FONDO: le sezioni sono card, e l'ultima si fermava a
          3px dal bordo della colonna invece dei 6 che ogni altra card ha su ogni
          lato — «sono attaccate in fondo» (Attilio, 09/08). Metà la porta il
          margine della card (`my-[3px]` in SECTION_CARD), metà questo padding:
          è la stessa regola della colonna principale. */}
      {/* `sidebar-column` MANCAVA QUI, e c'era invece nel gemello mobile: la
          correzione era stata applicata a metà.
          Il conto, da aperta: l'intestazione chiude con `md:pb-[6px]` — il passo
          PIENO — e la card «File» sotto ci aggiunge il suo mezzo (`my-[3px]` di
          SECTION_CARD), quindi fra il trigger e File passavano NOVE pixel dove
          ogni altra coppia di card ne ha sei. «Trigger aperto e File hanno
          distanza non conforme» (Attilio, 10/08) — e l'ipotesi che ci fosse
          stato un bordo lì è vicina: quello che c'è è il residuo di due passi
          sommati, uno del contenitore e uno della card.
          La classe azzera il mezzo passo della PRIMA card, che è esattamente la
          regola già scritta per la colonna principale e per il drawer: «ognuno
          porta metà passo, e il primo non porta la sua perché sopra c'è chi
          l'ha già messa». */}
      <div className="flex-1 flex flex-col min-h-0 pb-[3px] sidebar-column">

        {/* Files Section — always flex-1 to push Git/Processes to bottom */}
        {/* `pb-[3px]` da APERTA: mezzo passo, come ogni card della colonna.
            Misurato prima di toccarlo — fra due intestazioni CHIUSE passavano 7px
            (i due mezzi passi delle card più il pixel del divisore di
            ridimensionamento, che è nel flusso) e fra il contenuto di una sezione
            aperta e la card successiva solo 4, perché il contenuto non chiudeva
            con niente e restava il solo mezzo passo di chi veniva dopo. Due
            distanze diverse per la stessa cosa, e la seconda era quella che si
            vede di più: è esattamente il punto da cui è partito questo giro —
            «quando aperta, trigger e trigger degli altri accordion si trovano
            alla stessa distanza» (Attilio, 09/08). Adesso ci si trovano. */}
        <div ref={filesBoxRef} className={`flex flex-col flex-1 min-h-0 ${expandedSections.files ? 'pb-[3px]' : ''}`}>
          <div
            ref={filesHeaderRef}
            onClick={() => toggleSection('files')}
            // Ancora stabile, come per Git e Processi: l'etichetta e' testo
            // tradotto e questo e' un TOGGLE — chi lo clicca alla cieca su una
            // sezione gia' aperta la richiude.
            data-testid="project-sidebar-files"
            role="button"
            aria-expanded={expandedSections.files}
            // Il bordo sotto SOLO da chiusa. Il contenitore di «File» resta
            // `flex-1` anche quando è chiusa — serve a spingere Git e Processi
            // in fondo — quindi il divisore da 1px finisce in fondo alla
            // colonna, lontanissimo dall'intestazione: la riga chiusa restava
            // senza linea, sospesa sopra il vuoto. Da aperta non serve, perché
            // sotto ci sono i file.
            //
            // Il COLORE sta fuori dalla condizione, e non è pignoleria: si
            // alterna solo `border-b`, cioè la LARGHEZZA. Con
            // `border-b border-app-border` dentro il ramo, chiudendo la sezione
            // il bordo lampeggiava scuro e poi sbiadiva — `transition-colors`
            // anima anche `border-color`, la larghezza no. Il preflight di
            // Tailwind v4 mette `border: 0 solid` senza colore, quindi il
            // colore di partenza era `currentColor`, che qui è
            // `--text-secondary` (#5a5a5a) contro un `--border` di #e8e8e8:
            // la linea compariva quasi nera e ci metteva 150ms a schiarirsi.
            // Tenendo il colore sempre acceso non c'è più niente da animare.
            className={`${SECTION_CARD} group/files`}
          >
            <FolderTree size={14} className="flex-shrink-0" />
            <span>{tr('project.sidebar.files')}</span>
            <ChevronRight size={12} className={`transition-transform duration-150 text-app-text-tertiary flex-shrink-0 ${expandedSections.files ? 'rotate-90' : ''}`} />
            {expandedSections.files && (
              <div className={`ml-auto flex items-center gap-0.5 ${filesHeaderReveal}`} onClick={e => e.stopPropagation()}>
                <button onClick={() => fileExplorerRef.current?.newFile()} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary" title={tr('project.sidebar.newFile')}><FilePlus size={12} /></button>
                <button onClick={() => fileExplorerRef.current?.newFolder()} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary" title={tr('project.sidebar.newFolder')}><FolderPlus size={12} /></button>
                <button onClick={() => fileExplorerRef.current?.collapseAll()} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary" title={tr('project.sidebar.collapseAll')}><ChevronsDownUp size={12} /></button>
                <button onClick={() => fileExplorerRef.current?.refresh()} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary" title={tr('project.sidebar.refresh')}><RefreshCw size={12} /></button>
              </div>
            )}
          </div>
          {expandedSections.files && (
            <div className="flex-1 min-h-0 overflow-y-auto">
              <FileExplorer ref={fileExplorerRef} projectPath={projectPath} compact onOpenFile={onOpenFile} onWSMessage={onWSMessage} />
            </div>
          )}
        </div>

        {/* Resize handle: Files ↔ first expanded bottom section */}
        {(() => {
          const firstBottom: 'git' | 'processes' | null = (gitVisible && expandedSections.git) ? 'git' : expandedSections.processes ? 'processes' : null;
          const active = !!firstBottom;
          return (
            <div
              data-testid="project-sidebar-split-files"
              data-resize-active={active ? 'true' : 'false'}
              className={`h-[1px] flex-shrink-0 relative z-10 ${active ? 'cursor-row-resize' : ''}`}
              onMouseDown={active ? startBottomResize(firstBottom!) : undefined}
              // Doppio clic: la sezione torna ad adattarsi al contenuto.
              onDoubleClick={active ? resetBottomAuto(firstBottom!) : undefined}
              title={active ? tr('project.sidebar.resizeFit') : undefined}
            >
              {active && <div className="absolute inset-x-0 -top-[3px] -bottom-[3px]" />}
            </div>
          );
        })()}

        {/* Git Section — anchored at bottom, fixed pixel height. Absent when
            the repository has nothing to report: see `gitVisible`. */}
        {gitVisible && <div
          data-testid="project-sidebar-git-section"
          ref={el => { sectionsRef.current.git = el; }}
          className={`flex flex-col overflow-hidden ${expandedSections.git ? 'min-h-0 pb-[3px]' : 'flex-shrink-0'}`}
          style={expandedSections.git
              // Automatica: l'altezza la dà il contenuto, con il tetto di
              // `capSezione`. Trascinata: il numero vince, ed è una deroga
              // esplicita — chi ha tirato il divisore ha detto «così».
              ? (bottomHeights.git === null
                  // Fra il MINIMO UTILE e il tetto: «si adatta al contenuto»
                  // non vuol dire «può diventare una fessura». Il pavimento
                  // è quello che già esisteva per il trascinamento
                  // (`MIN_USEFUL_H`), ed è per sezione perché il chrome delle
                  // due è diverso: sotto quella misura il pannello non
                  // conterrebbe nemmeno se stesso.
                  ? { minHeight: MIN_USEFUL_H.git, maxHeight: capSezione() }
                  : { height: bottomHeights.git })
              : undefined}
        >
          <Suspense fallback={
            <div
              onClick={() => toggleSection('git')}
              className={SECTION_CARD}
            >
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <GitBranch size={14} className={`flex-shrink-0 ${git ? '' : 'text-app-text-muted'}`} />
                <span>{tr('project.sidebar.gitChanges')}</span>
                <ChevronRight size={12} className={`flex-shrink-0 transition-transform duration-150 text-app-text-tertiary ${expandedSections.git ? 'rotate-90' : ''}`} />
                {git && (
                  <span className="text-app-text-muted truncate">{git.branch}</span>
                )}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0 ml-1" onClick={e => e.stopPropagation()}>
                {git && git.fileCount > 0 && (
                  <span className="text-[11px] font-medium text-primary bg-primary/10 px-1.5 py-[1px] rounded-full">
                    {git.fileCount}
                  </span>
                )}
                {git && git.behind > 0 && (
                  <span className="text-[11px] font-medium text-red-600 dark:text-red-400 bg-red-500/10 px-1 py-[1px] rounded-full">
                    ↓{git.behind}
                  </span>
                )}
                {git && git.ahead > 0 && (
                  <span className="text-[11px] font-medium text-green-600 dark:text-green-400 bg-green-500/10 px-1 py-[1px] rounded-full">
                    ↑{git.ahead}
                  </span>
                )}
                <span className="w-4 h-4 inline-flex items-center justify-center text-app-text-tertiary">
                  <span className="inline-flex items-center justify-center w-[10px] h-[10px] animate-spin">
                    <RefreshCw size={10} />
                  </span>
                </span>
              </div>
            </div>
          }>
            <GitChanges
              projectPath={projectPath}
              compact
              expanded={expandedSections.git}
              onToggle={() => toggleSection('git')}
            />
          </Suspense>
        </div>}

        {/* Resize handle: Git ↔ Processes */}
        {(() => {
          const active = gitVisible && expandedSections.git && expandedSections.processes;
          return (
            <div
              data-testid="project-sidebar-split-git-processes"
              data-resize-active={active ? 'true' : 'false'}
              className={`h-[1px] flex-shrink-0 relative z-10 ${active ? 'cursor-row-resize' : ''}`}
              // SOTTO il divisore ci sono i Processi: sono loro a crescere
              // quando lo si alza. Qui c'era `('git','processes')`.
              onMouseDown={active ? startBottomResize('processes', 'git') : undefined}
              onDoubleClick={active ? resetBottomAuto('processes', 'git') : undefined}
              title={active ? tr('project.sidebar.resizeFit') : undefined}
            >
              {active && <div className="absolute inset-x-0 -top-[3px] -bottom-[3px]" />}
            </div>
          );
        })()}

        {/* Processes Section — anchored at bottom, fixed pixel height */}
        <div
          ref={el => { sectionsRef.current.processes = el; }}
          className={`flex flex-col overflow-hidden ${expandedSections.processes ? 'min-h-0 pb-[3px]' : 'flex-shrink-0'}`}
          style={expandedSections.processes
              // Automatica: l'altezza la dà il contenuto, con il tetto di
              // `capSezione`. Trascinata: il numero vince, ed è una deroga
              // esplicita — chi ha tirato il divisore ha detto «così».
              ? (bottomHeights.processes === null
                  // Fra il MINIMO UTILE e il tetto: «si adatta al contenuto»
                  // non vuol dire «può diventare una fessura». Il pavimento
                  // è quello che già esisteva per il trascinamento
                  // (`MIN_USEFUL_H`), ed è per sezione perché il chrome delle
                  // due è diverso: sotto quella misura il pannello non
                  // conterrebbe nemmeno se stesso.
                  ? { minHeight: MIN_USEFUL_H.processes, maxHeight: capSezione() }
                  : { height: bottomHeights.processes })
              : undefined}
        >
          <button
            onClick={() => toggleSection('processes')}
            // Stessa ancora della variante mobile qui sopra: l'etichetta è
            // tradotta (9d1991ea) e il bottone è un toggle, quindi il testid dice
            // «quale controllo» e `aria-expanded` dice «è già aperto?».
            data-testid="project-sidebar-processes"
            aria-expanded={expandedSections.processes}
            className={SECTION_CARD}
          >
            <CirclePlay size={14} className="flex-shrink-0" />
            <span>{tr('project.sidebar.processes')}</span>
            <ChevronRight size={12} className={`transition-transform duration-150 text-app-text-tertiary flex-shrink-0 ${expandedSections.processes ? 'rotate-90' : ''}`} />
            {runningCount > 0 && (
              <span className="ml-auto text-[11px] font-medium text-green-600 dark:text-green-400 bg-green-500/10 px-1.5 py-[1px] rounded-full">
                {runningCount}
              </span>
            )}
          </button>
          {expandedSections.processes && (
            <div className="flex-1 min-h-0 overflow-y-auto">
              <ScriptRunner projectPath={projectPath} onOpenProcessLog={onOpenProcessLog} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
