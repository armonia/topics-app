import { useState, useEffect, useRef, useCallback, lazy, Suspense, type ReactNode } from 'react';
import { useT } from '../../hooks/useT';
import { createPortal } from 'react-dom';
import { FolderTree, GitBranch, CirclePlay, RefreshCw, PanelLeftOpen, PanelLeftClose, FilePlus, FolderPlus, ChevronsDownUp } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { NO_DRAG_REGION } from '../../lib/shell/dragRegion';
import { RAISED_CONTROL, RESTING_SURFACE, ROW_ACTION_BOX, ROW_PX, SECTION_TAB, SECTION_TOOLS, SELECTED_SURFACE, TAB_GAP_CLASS, TAB_LABEL } from '../../lib/selectionStyles';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { ScriptRunner } from './ScriptRunner';
import { FileExplorer, type FileExplorerHandle } from './FileExplorer';
import { useScripts } from '../../hooks/useScripts';
import { useGitStatus } from '../../hooks/useGitStatus';
import { isRecentFailure } from '../../lib/processFailure';
import { DRAG_SLOP_PX } from '../../hooks/useGridResize';
import type { WSMessage } from '../../types';

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
}: {
  projectPath: string;
  name: string;
  collapsed: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const tr = useT();
  const etichetta = collapsed ? tr('project.sidebar.expand') : tr('project.sidebar.hide');
  return (
    <button
      onClick={onToggle}
      title={`${name} — ${etichetta}`}
      aria-label={etichetta}
      aria-expanded={!collapsed}
      data-testid="project-card"
      className={`group edge-lit flex items-center gap-1.5 ${ROW_PX} h-9 md:h-7 ${TAB_LABEL} ${RESTING_SURFACE} rounded-lg transition-colors cursor-pointer select-none min-w-0 ${className}`}
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
      className={`relative ${ROW_ACTION_BOX} flex items-center justify-center rounded-lg edge-lit transition-colors flex-shrink-0 ${
        active ? 'text-primary bg-primary/10' : `${RAISED_CONTROL} text-app-text`
      }`}
    >
      <Icon size={16} />
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
  // Project name = the display override (task title) or the path's folder name.
  const projectName = displayName || projectPath.split('/').filter(Boolean).pop() || 'Project';
  // Auto-collapse on mobile
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const h = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);

  // On mobile, start collapsed but allow toggling (renders as overlay)
  const effectiveCollapsed = collapsed;
  // Le chiavi portano il PROGETTO. Erano globali — `sidebar-sections` e
  // `project-sidebar-bottom-heights` secche — quindi due progetti affiancati si
  // scambiavano apertura e altezze, e ciò che avevi stretto su uno arrivava
  // stretto sull'altro senza averlo mai toccato lì.
  const SECTIONS_KEY = `sidebar-sections:${projectPath}`;
  const [expandedSections, setExpandedSections] = useState<Record<SectionId, boolean>>(() => {
    try {
      const saved = sessionStorage.getItem(SECTIONS_KEY) ?? sessionStorage.getItem('sidebar-sections');
      if (saved) return JSON.parse(saved);
    } catch {}
    return { files: true, git: false, processes: false };
  });

  // Persist expanded sections across page refreshes
  useEffect(() => {
    try { sessionStorage.setItem(SECTIONS_KEY, JSON.stringify(expandedSections)); } catch {}
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

  // UNA ALLA VOLTA. Le tre sezioni stavano impilate e aperte insieme, con
  // altezze in pixel e un divisore trascinabile fra loro; ora stanno in una
  // riga di chip sopra un pannello solo («devono essere dropdown singoli, al
  // massimo puoi aprire [uno]», Attilio 09/08). Aprirne una chiude le altre —
  // e chiuderla senza aprirne un'altra resta possibile, che è la differenza
  // fra un menu a tendina e una scheda: qui il pannello può anche non esserci.
  const toggleSection = (section: SectionId) => {
    setExpandedSections(prev => {
      const opening = !prev[section];
      // Il cancello sulle altezze salvate se n'è andato con le altezze: una
      // sezione aperta prende TUTTO lo spazio sotto la riga, quindi non può
      // più «aprirsi su zero pixel» — che era il difetto per cui esisteva.
      return { files: false, git: false, processes: false, [section]: opening };
    });
  };

  // ── Larghezza della barra ────────────────────────────────────────────────
  // Per progetto, come apertura e altezze: un albero di file profondo e uno
  // piatto non vogliono la stessa colonna, e la misura giusta è quella che hai
  // scelto lì.
  const WIDTH_KEY = `project-sidebar-width:${projectPath}`;
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = sessionStorage.getItem(WIDTH_KEY);
      const n = saved ? parseInt(saved, 10) : NaN;
      if (Number.isFinite(n)) return Math.min(MAX_SIDEBAR_W, Math.max(MIN_SIDEBAR_W, n));
    } catch {}
    return DEFAULT_SIDEBAR_W;
  });
  useEffect(() => {
    try { sessionStorage.setItem(WIDTH_KEY, String(sidebarWidth)); } catch {}
  }, [WIDTH_KEY, sidebarWidth]);

  const widthDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Full-viewport drag chrome (same protocol as useGridResize): keeps the
  // pointer out of iframes in the main area mid-drag and lets native Electron
  // WebContentsView panes hide via pane-resize-start/end. Raised lazily on
  // the first real movement so a bare click never retargets its mouseup.
  const dragOverlay = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
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
    const raiseChrome = (cursor: 'col-resize') => {
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
    };
    const onUp = () => {
      if (!widthDragRef.current) return;
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
   * LA RIGA DELLE TRE SEZIONI, e sotto il pannello di quella aperta.
   *
   * Funzione e non componente: un componente definito qui dentro sarebbe un
   * TIPO nuovo a ogni render, e React smonterebbe e rimonterebbe tutto il
   * sottoalbero a ogni battito — l'albero dei file perderebbe le cartelle
   * aperte e lo scorrimento a ogni tasto premuto altrove. Così invece il JSX
   * finisce inline nello stesso albero, che è quello che serve: una sola
   * grammatica per il cassetto mobile e per la colonna desktop, che prima erano
   * due copie e divergevano al primo ritocco fatto da una parte sola.
   */
  const chip = (id: SectionId, glifo: ReactNode, etichetta: string, pastiglia?: ReactNode) => {
    const attiva = expandedSections[id];
    return (
      <button
        onClick={() => toggleSection(id)}
        // Le ancore restano quelle di prima — `project-sidebar-<sezione>` con
        // `aria-expanded` — perché a cambiare è dove sta il comando, non cosa
        // fa. GitChanges la sua l'ha persa (`chromeless`): due elementi con la
        // stessa ancora sono un locator ambiguo, non un dettaglio.
        data-testid={`project-sidebar-${id}`}
        aria-expanded={attiva}
        title={etichetta}
        className={`${SECTION_TAB} ${attiva ? SELECTED_SURFACE : RESTING_SURFACE}`}
      >
        {glifo}
        <span className="truncate">{etichetta}</span>
        {pastiglia}
      </button>
    );
  };

  /** I comandi dell'albero dei file: erano nell'intestazione della sezione, e
   *  quando l'intestazione è salita nella riga sono rimasti senza casa. Qui
   *  stanno sempre visibili invece che in hover: la striscia esiste SOLO
   *  mentre la sezione è aperta, quindi non c'è niente da rivelare. */
  const comandiFile = (
    <div className={SECTION_TOOLS}>
      <button onClick={() => fileExplorerRef.current?.newFile()} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary" title={tr('project.sidebar.newFile')}><FilePlus size={12} /></button>
      <button onClick={() => fileExplorerRef.current?.newFolder()} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary" title={tr('project.sidebar.newFolder')}><FolderPlus size={12} /></button>
      <button onClick={() => fileExplorerRef.current?.collapseAll()} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary" title={tr('project.sidebar.collapseAll')}><ChevronsDownUp size={12} /></button>
      <button onClick={() => fileExplorerRef.current?.refresh()} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary" title={tr('project.sidebar.refresh')}><RefreshCw size={12} /></button>
    </div>
  );

  const sezioni = (
    <>
      <div className={`flex items-center ${TAB_GAP_CLASS} px-1.5 pb-[3px] flex-shrink-0`}>
        {chip('files', <FolderTree size={14} className="flex-shrink-0" />, tr('project.sidebar.files'))}
        {chip(
          'git',
          <GitBranch size={14} className={`flex-shrink-0 ${git ? '' : 'text-app-text-muted'}`} />,
          tr('project.sidebar.gitChanges'),
          git && git.fileCount > 0
            ? <span className="flex-shrink-0 text-[11px] font-medium text-primary bg-primary/10 px-1.5 py-[1px] rounded-full">{git.fileCount}</span>
            : undefined,
        )}
        {chip(
          'processes',
          <CirclePlay size={14} className="flex-shrink-0" />,
          tr('project.sidebar.processes'),
          // Un fallimento recente batte il conteggio: è l'unico dei due che
          // chiede qualcosa a chi guarda.
          failedCount > 0
            ? <span className="flex-shrink-0 text-[11px] font-medium text-red-600 dark:text-red-400 bg-red-500/10 px-1.5 py-[1px] rounded-full">{failedCount}</span>
            : runningCount > 0
              ? <span className="flex-shrink-0 text-[11px] font-medium text-green-600 dark:text-green-400 bg-green-500/10 px-1.5 py-[1px] rounded-full">{runningCount}</span>
              : undefined,
        )}
      </div>
      <div className="flex-1 flex flex-col min-h-0 pb-[3px]">
        {expandedSections.files && (
          <>
            {comandiFile}
            <div className="flex-1 min-h-0 overflow-y-auto">
              <FileExplorer ref={fileExplorerRef} projectPath={projectPath} compact onOpenFile={onOpenFile} onWSMessage={onWSMessage} />
            </div>
          </>
        )}
        {expandedSections.git && (
          <div className="flex-1 flex flex-col min-h-0">
            <Suspense fallback={<div className={SECTION_TOOLS} />}>
              <GitChanges projectPath={projectPath} compact chromeless expanded onToggle={() => toggleSection('git')} />
            </Suspense>
          </div>
        )}
        {expandedSections.processes && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <ScriptRunner projectPath={projectPath} onOpenProcessLog={onOpenProcessLog} />
          </div>
        )}
      </div>
    </>
  );

  if (effectiveCollapsed) {
    const open = (section: SectionId) => () => {
      onToggleCollapse();
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
          icon={FolderTree}
          active={expandedSections.files}
          onClick={open('files')}
          title={tr('project.sidebar.files')}
        />
        <RailButton
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
        />
        <RailButton
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
    return createPortal(
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
          <ProjectCard
            projectPath={projectPath}
            name={projectName}
            collapsed
            onToggle={onToggleCollapse}
            className="max-w-[180px] flex-shrink"
          />
          {comandi()}
        </div>,
        inlineSlot,
    );
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
          {sezioni}
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
      className="chrome-glass flex-shrink-0 bg-app-chrome flex flex-col overflow-hidden relative"
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

      {sezioni}
    </div>
  );
}
