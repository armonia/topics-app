/**
 * IL FILTRO «PROGETTO» DELLA BOARD, chip e suggerimenti in un pezzo solo.
 *
 * Nella barra c'erano DUE oggetti che parlavano dello stesso filtro, e in due
 * punti lontani della riga: il chip «Progetto» (col menu di ricerca) fra gli
 * altri filtri, e in coda alla barra una striscia di chip-suggerimento, uno per
 * progetto, che appariva quando avanzava spazio. Chi guardava la barra vedeva
 * due controlli diversi; chi la leggeva nel codice trovava lo stesso stato
 * calcolato per entrambi in mezzo agli altri filtri.
 *
 * Qui stanno insieme: il chip apre la lista completa (ricerca, cento progetti),
 * i suggerimenti sono la stessa lista sporta fuori finche' c'e' larghezza. Un
 * componente solo, un solo posto in cui si decide cosa e' selezionato.
 *
 * LA REGOLA DELLA STRISCIA, invariata: la barra non si deforma mai per far
 * stare i suggerimenti. Niente a capo (spingerebbe giu' la board), niente
 * compressione fino all'illeggibile; chi non entra resta dietro il chip.
 * Il conto si fa sulla geometria vera, non su una stima di caratteri: i chip
 * sono TUTTI renderizzati in una riga `nowrap` dentro un contenitore che occupa
 * lo spazio residuo, e quelli il cui bordo destro cade oltre il bordo del
 * contenitore diventano `invisible`. Tre proprieta', ed e' per questo che il
 * modo e' questo:
 *   · `visibility:hidden` tiene la posizione, quindi le misure dei chip
 *     precedenti non cambiano quando l'ultimo sparisce: nessun ciclo in cui
 *     nascondere un chip libera lo spazio che lo rifa' comparire.
 *   · il contenitore ha `min-w-0` + `overflow-hidden`, quindi la sua larghezza
 *     MINIMA e' zero: quando la riga e' affollata collassa a 0, nessun chip
 *     entra, e non allarga la barra di un pixel. E' lo stesso motivo per cui un
 *     chip a meta' non si vede mai: sotto il taglio e' invisibile, non tagliato.
 *   · la riga dei chip e' ASSOLUTA (`w-max`), e questo non e' un dettaglio di
 *     stile: un figlio in flusso con `basis-0` contribuisce lo stesso la sua
 *     larghezza MAX-CONTENT al calcolo intrinseco del genitore, e il genitore
 *     qui sta dentro una barra che scorre. Misurato: con la riga in flusso, a
 *     1000px la barra eccedeva di 243px, cioe' i chip si prendevano lo spazio
 *     invece di aspettare quello che avanza. Fuori flusso contribuisce zero, e
 *     la striscia riceve SOLO cio' che resta.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { Menu } from '../Shared/Menu';
import { Tooltip } from '../Shared/Tooltip';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { homeTilde } from '../../lib/homeTilde';
import { isProjectlessId, STATUS_LABEL, UNASSIGNED_PROJECT_ID, type BoardProjectRef, type BoardTask } from '../../lib/board';
import { resolveProjectRefs, useBoardProjects } from '../../lib/boardProjectsStore';
import { countsSummary, projectTaskCounts } from '../../lib/projectTaskCounts';
import { ProjectPickerBody } from './ProjectPicker';
import { ProjectTaskCounts } from './atoms';
import { filterChipClass } from './constants';

/**
 * Il respiro fra il contenuto e il bordo del fondino, per lato (px).
 *
 * UNO SOLO, e vale su tutti e quattro i lati: 4px a destra li aggiunge la
 * misura qui sotto, 4px a sinistra sono il `px-1` dell'ospite, 4px sopra e
 * sotto sono il `-inset-y-1` del fondino. Prima il verticale era ZERO
 * (`inset-y-0` su un ospite alto quanto i chip): il bordo passava rasente al
 * chip, e un riquadro che tocca il suo contenuto si legge come un errore di
 * allineamento, non come un raggruppamento.
 */
const SHELL_PAD = 4;

/**
 * LA SCATOLA DELL'ICONA, la stessa per ogni chip.
 *
 * `ProjectFavicon` disegna il `fallback` NUDO, senza riservargli larghezza (è
 * dichiarato: «no path → no element, no reserved width»). Il fallback qui era
 * un punto da 6px contro un'icona da 12: i chip di un progetto con icona e di
 * uno senza rientravano in modo diverso, e in fila i nomi non erano
 * incolonnati. La scatola sta FUORI dal favicon, così la larghezza del chip
 * non dipende più da quali progetti abbiano un'icona su disco.
 */
const ICON_BOX = 12;

/**
 * La larghezza massima di un chip, la stessa per il chip che apre il menu e
 * per i suggerimenti: erano `11rem` e `13rem`, cioè lo stesso oggetto troncato
 * a due misure diverse nella stessa riga.
 */
const CHIP_MAX = 'max-w-[12rem]';

function ChipIcon({ path }: { path: string }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center"
      style={{ width: ICON_BOX, height: ICON_BOX }}
    >
      <ProjectFavicon
        path={path}
        size={ICON_BOX}
        fallback={<span className="h-1.5 w-1.5 rounded-full border border-app-text-faint" />}
      />
    </span>
  );
}

export function ProjectFilterPicker({ tasks, mode, selectedIds: selectedFilterIds, onChange }: {
  tasks: readonly BoardTask[];
  /** I progetti si filtrano solo dove ce n'e' piu' di uno: la board «tutti». */
  mode: 'project' | 'all';
  /** Gli id accesi nel filtro (quelli veri, non le righe sintetiche). */
  selectedIds: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const tr = useT();
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  // LO STESSO indice progetti del composer. Prima questo filtro era un widget a
  // parte che dell'indice non sapeva nulla: niente ricerca, niente icone, e come
  // nome l'id della board con l'hash tagliato via (`topics-app-4f2c` →
  // «topics-app»), che assomiglia al nome vero ma non lo e'. Ora la lista passa
  // per `resolveProjectRefs`, che risolve nome e `path` (e senza `path` non c'e'
  // icona) dallo stesso indice che alimenta il chip del composer e il «Sposta
  // su…» del drawer.
  const projectIndex = useBoardProjects(mode === 'all');
  const taskProjectIds = useMemo(() => Array.from(new Set(tasks.map((t) => t.projectId))), [tasks]);
  // I task «senza progetto» sono di DUE specie (`_none` e la board catch-all
  // `generale-<hash>`), ma per chi filtra sono una cosa sola: una riga, che
  // accende e spegne entrambi gli id.
  const projectlessIds = useMemo(() => taskProjectIds.filter(isProjectlessId), [taskProjectIds]);
  // Quanti task, e in che stato. Il nome da solo non dice se quel progetto stia
  // aspettando qualcuno o non abbia niente di aperto, ed e' la domanda che si fa
  // chi guarda una board generale con dodici progetti.
  const projectCounts = useMemo(
    () => projectTaskCounts(tasks, (t) => (isProjectlessId(t.projectId) ? UNASSIGNED_PROJECT_ID : t.projectId)),
    [tasks],
  );
  const projectOptions = useMemo(() => {
    const refs = resolveProjectRefs(taskProjectIds.filter((id) => !isProjectlessId(id)), projectIndex);
    return projectlessIds.length
      ? [{ projectId: UNASSIGNED_PROJECT_ID, name: 'Senza progetto', path: '' }, ...refs]
      : refs;
  }, [taskProjectIds, projectlessIds, projectIndex]);
  const showProjects = mode === 'all' && projectOptions.length > 0;

  // Gli id che la riga «Senza progetto» rappresenta davvero.
  const idsFor = (p: BoardProjectRef) =>
    (p.projectId === UNASSIGNED_PROJECT_ID && projectlessIds.length ? projectlessIds : [p.projectId]);
  const selectedRowIds = useMemo(() => {
    const sel = new Set(selectedFilterIds);
    // La riga sintetica si accende se e' acceso uno QUALSIASI dei suoi id.
    if (projectlessIds.some((id) => sel.has(id))) sel.add(UNASSIGNED_PROJECT_ID);
    return Array.from(sel);
  }, [selectedFilterIds, projectlessIds]);
  const toggleProject = (p: BoardProjectRef) => {
    const ids = idsFor(p);
    const on = ids.some((id) => selectedFilterIds.includes(id));
    onChange(on
      ? selectedFilterIds.filter((x) => !ids.includes(x))
      : [...selectedFilterIds, ...ids.filter((id) => !selectedFilterIds.includes(id))]);
  };
  // Le RIGHE accese (non gli id: «Senza progetto» ne rappresenta due). Un solo
  // progetto filtrato → il chip lo MOSTRA (icona + nome), invece di dire
  // «Progetto ·1» e costringere ad aprire il menu per sapere quale.
  const pickedProjects = useMemo(
    () => projectOptions.filter((p) => selectedRowIds.includes(p.projectId)),
    [projectOptions, selectedRowIds],
  );
  const soleProject = pickedProjects.length === 1 ? pickedProjects[0]! : null;

  const hostRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const stripRowRef = useRef<HTMLDivElement>(null);
  const [inlineProjects, setInlineProjects] = useState(0);
  /* LA CONCHIGLIA, in pixel. Il blocco occupa tutta la larghezza che avanza
     nella riga, ma i suggerimenti finiscono dove finisce l'ultimo chip che ci
     sta: disegnare il bordo sul contenitore darebbe una scatola vuota lunga
     fino al fondo della barra. Qui si misura il bordo destro di cio' che si
     vede davvero, e il fondino si ferma li'. */
  const [shellWidth, setShellWidth] = useState(0);
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!showProjects || !strip) { setInlineProjects(0); setShellWidth(0); return; }
    const measure = () => {
      const row = stripRowRef.current;
      if (!row) return;
      const avail = strip.clientWidth;
      let fit = 0;
      // I CHIP, non i figli della riga. Da quando ogni chip e' avvolto nel
      // `Tooltip`, i figli diretti sono wrapper `display: contents`: per il
      // layout non esistono (ed e' il motivo per cui si usa `contents`), ma nel
      // DOM ci sono e hanno `offsetWidth` ZERO. La misura li vedeva larghi
      // nulla, concludeva che ci stavano tutti, e i chip in eccesso finivano
      // oltre il bordo destro invece che dentro il menu. `querySelectorAll` sul
      // testid salta i wrapper e misura cio' che si vede davvero.
      const chips = Array.from(row.querySelectorAll<HTMLElement>('[data-testid^="project-filter-chip-"]'));
      for (const chipEl of chips) {
        // +0.5: le larghezze sono frazionarie, e un mezzo pixel di
        // arrotondamento non e' un chip che non ci sta.
        if (chipEl.offsetLeft + chipEl.offsetWidth <= avail + 0.5) fit++;
        else break;
      }
      setInlineProjects((n) => (n === fit ? n : fit));
      // Dove finisce il blocco: il chip da solo se non sporge nessun
      // suggerimento, altrimenti il bordo destro dell'ultimo che ci sta.
      const btn = btnRef.current;
      let right = btn ? btn.offsetLeft + btn.offsetWidth : 0;
      const last = fit > 0 ? chips[fit - 1] : null;
      if (last) right = Math.max(right, strip.offsetLeft + last.offsetLeft + last.offsetWidth);
      const w = Math.ceil(right) + SHELL_PAD;
      setShellWidth((v) => (v === w ? v : w));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    ro.observe(stripRowRef.current!);
    return () => ro.disconnect();
  }, [showProjects, projectOptions]);

  /**
   * Il contenuto del tooltip di un suggerimento. Prima era una riga sola dentro
   * un `title=` nativo: il sistema operativo la mostrava dopo un secondo
   * abbondante e senza struttura. Segnalato: «passando sui filtri dovrebbe dare
   * un minimo di informazioni sul progetto, magari anche la location».
   *
   * Tre cose, in ordine di quanto servono: il NOME (che nel chip e' troncato a
   * `CHIP_MAX`), DOVE STA su disco (l'unica cosa che distingue due progetti chiamati
   * uguale in cartelle diverse), e come stanno i task.
   */
  const countsTitle = (p: BoardProjectRef) => {
    const c = projectCounts[p.projectId];
    return (
      <div className="space-y-1">
        <div className="font-medium">{p.name}</div>
        {p.path ? (
          // Monospazio e a capo sul percorso: un path lungo su una riga sola
          // diventa illeggibile, ed e' proprio il dato che si viene a cercare.
          <div className="break-all font-mono text-[10px] text-app-text-muted">{homeTilde(p.path)}</div>
        ) : (
          // Perche' non c'e': senza questa riga il tooltip di un progetto sparito
          // sembra solo un tooltip a cui manca un pezzo.
          <div className="text-[10px] text-app-text-faint">{tr('board.filter.projectUnknown')}</div>
        )}
        {c && <div className="text-[10px] text-app-text-muted">{countsSummary(c, STATUS_LABEL)}</div>}
      </div>
    );
  };

  if (!showProjects) return null;

  return (
    /* `grow basis-0` + `min-w-0`: il blocco prende SOLO lo spazio che avanza
       nella riga dei filtri, e la sua larghezza minima e' quella del chip. */
    <div ref={hostRef} className="relative flex min-w-0 grow basis-0 items-center gap-1.5 px-1" data-testid="project-filter">
      {/* IL FONDINO che tiene insieme chip e suggerimenti: senza, restano due
          oggetti vicini e chi guarda non ha modo di sapere che i progetti li'
          in fila SONO il selettore aperto sulla riga. Sta dietro (assoluto,
          `pointer-events-none`), quindi non entra in nessuna misura.

          I COLORI SONO A COPPIE, e non e' un vezzo: nato `border-white/15
          bg-white/[0.05]`, il fondino era bianco su bianco in tema chiaro,
          cioe' invisibile proprio dove lo si stava cercando (segnalato tre
          volte: «ancora non sono wrappati dal selettore»). E' l'errore che la
          REGOLA in cima a `index.css` descrive parola per parola: un rialzo
          si dichiara `bg-black/N dark:bg-white/N`, oppure con i token opachi.
          Il bordo passa a un token, che i due temi risolvono da se'. E' la
          variante `-light` e non quella base perche' i numeri lo impongono:
          in chiaro `--border` vale 91,4% di lightness su un fondo che ne vale
          93 (differenza 1,6: un bordo che non c'e'), e in SCURO sarebbe
          18% contro il 24,8 a cui arrivava il vecchio bianco/15, cioe' un
          passo indietro proprio dove qualcosa si vedeva. `--border-light`
          e' 88,5% in chiaro e 24% in scuro: meglio del bordo base nel primo,
          pari al vecchio nel secondo. Nessun tema ci perde. */}
      <div
        aria-hidden
        data-testid="project-filter-shell"
        className="pointer-events-none absolute -inset-y-1 left-0 rounded-md border border-app-border-light bg-black/[0.05] dark:bg-white/[0.06]"
        style={{ width: shellWidth || undefined }}
      />
      <button
        ref={btnRef} onClick={() => setOpen(true)}
        data-testid="filter-project-chip"
        title={soleProject ? tr('board.filter.projectNamed', { name: soleProject.name }) : tr('board.filter.projectTitle')}
        className={`${filterChipClass(selectedFilterIds.length > 0)} min-w-0 ${CHIP_MAX}`}
      >
        {soleProject && <ChipIcon path={soleProject.path} />}
        <span className="min-w-0 truncate">{soleProject ? soleProject.name : tr('common.project')}</span>
        {!soleProject && pickedProjects.length > 0 && (
          <span className="tabular-nums text-app-text-secondary">·{pickedProjects.length}</span>
        )}
        <ChevronDown className="h-3 w-3 shrink-0 text-app-text-muted" />
      </button>
      {/* LO STESSO `ProjectPickerBody` del composer, in modalita' multi-selezione:
          il menu non si chiude a ogni clic perche' un filtro si costruisce a
          piu' scelte. */}
      <Menu open={open} anchorRef={btnRef} onClose={() => setOpen(false)} minWidth={230} role="listbox" unmanagedFocus>
        <ProjectPickerBody
          projects={projectOptions}
          selectedIds={selectedRowIds}
          onPick={toggleProject}
          busy={false}
          listLabel={tr('common.project')}
          counts={projectCounts}
        />
      </Menu>

      {/* I SUGGERIMENTI, nello spazio che avanza. Vedi il `useLayoutEffect`. */}
      <div ref={stripRef} className="relative h-6 min-w-0 grow basis-0 overflow-hidden" data-testid="project-filter-strip">
        <div ref={stripRowRef} className="absolute inset-y-0 left-0 flex w-max flex-nowrap items-center gap-1.5 [&>*]:shrink-0">
          {projectOptions.map((p, i) => {
            const on = selectedRowIds.includes(p.projectId);
            const shown = i < inlineProjects;
            return (
              // Il `key` sta sul Tooltip: e' lui il figlio della lista ora.
              <Tooltip key={p.projectId} content={countsTitle(p)}>
              <button
                onClick={() => toggleProject(p)}
                aria-hidden={!shown}
                tabIndex={shown ? 0 : -1}
                data-testid={`project-filter-chip-${p.projectId}`}
                className={`${filterChipClass(on)} min-w-0 ${CHIP_MAX} ${shown ? '' : 'invisible'}`}
              >
                <ChipIcon path={p.path} />
                <span className="min-w-0 truncate">{p.name}</span>
                {projectCounts[p.projectId] && <ProjectTaskCounts counts={projectCounts[p.projectId]!} />}
                {on && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
              </button>
              </Tooltip>
            );
          })}
        </div>
      </div>
    </div>
  );
}
