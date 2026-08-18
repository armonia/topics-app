import { useCallback, useMemo, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { StatusIcon } from '../Board/atoms';
import { STATUS_GLYPH_PX, STATUS_LABEL, type BoardTask, type TaskStatus } from '../../lib/board';
import { SUMMARY_STATUSES } from '../../lib/boardTabCounts';
import { useBoardProjects } from '../../lib/boardProjectsStore';
import { useT } from '../../hooks/useT';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { useProjectIconsPresent } from '../Shared/projectIconStore';
import {
  boardProjectChips, fitBoardRow, CHIP_SPACING, CHIP_INNER_GAP, GROUP_SPACING, CHIP_W_ICON, chipWidth, contaLeggibile,
  type BoardProjectChip,
} from './boardProjectChips';

/** La scatola dell'icona: `CHIP_W_ICON` meno niente, perché senza superficie la
 *  pastiglia non ha più padding — lo slot È la pastiglia, nel gradino povero. */
const ICON_SLOT_W = CHIP_W_ICON;

/** Il `gap-2` del bottone della riga «Board», dove questo riassunto è un
 *  fratello dell'etichetta. Serve a sapere quanto manca per arrivare a
 *  `GROUP_SPACING`: è l'unico numero che questo file non controlla. */
const BOARD_ROW_GAP = 8;

/**
 * Gli stati riassunti sulla riga: chi aspetta te, e chi sta lavorando.
 *
 * DUE, non quattro. `todo` e `backlog` sono usciti, e non per fare spazio a
 * caso: il criterio era già scritto qui — «i primi devono essere quelli che
 * cambiano una decisione» — e la coda non ne cambia nessuna. Sapere che ci sono
 * 36 task in backlog, sulla riga di una sidebar, non fa fare niente di diverso;
 * sapere che 8 aspettano te sì.
 *
 * Costava, e il conto è misurato con le funzioni pure del ritaglio: `review 8`
 * più `backlog 36` occupano 63 dei ~160px elastici, e alle pastiglie ne restano
 * 90,84 — quanto basta per UNA pastiglia col solo nome. Senza la coda i conteggi
 * scendono a 25-56px e le pastiglie arrivano a 97-129, cioè lo spazio in cui la
 * pastiglia può tornare a dire ANCHE quanti task ha quel progetto. È la stessa
 * riga, spesa meglio.
 *
 * L'ordine resta anche quello in cui la coda si arrotola (`fitStatusCounts`): si
 * perde «in corso», mai «review». `done` resta fuori: la board si annuncia per
 * il lavoro APERTO.
 *
 * La costante è emigrata in `lib/boardTabCounts` il giorno in cui la TAB della
 * board ha cominciato a dire le stesse due cose: due elenchi paralleli sarebbero
 * la premessa perché la sidebar e la tab riassumano la stessa board in modo
 * diverso. Il ragionamento resta qui, dov'è stato fatto.
 */

/**
 * UNA PASTIGLIA DI PROGETTO — e adesso è davvero una pastiglia.
 *
 * Erano tre `<span>` nudi in fila: nessuna superficie, nessun padding, nessun
 * confine fra il nome e il numero — stesso corpo, stesso colore, 4px in mezzo.
 * Con un nome tagliato a ~34px il numero si leggeva come l'ultima sillaba del
 * nome («il numero si confonde con i progetti», Attilio). Tre correzioni, tutte
 * nello stesso pezzo:
 *
 *  · una SUPERFICIE con la sua forma, così i pezzi si leggono come UNA unità;
 *  · lo slot dell'icona SEMPRE riservato (`w-3`, anche vuoto). `ProjectFavicon`
 *    non rende niente quando il progetto non ha un'icona vera — decisione dura
 *    e riconfermata: niente lettere, niente tessere generate — quindi senza lo
 *    slot il nome partiva 16px più a sinistra e la pastiglia aveva un layout
 *    INTERNO diverso dalle vicine pur avendo la stessa larghezza esterna;
 *  · IL NUMERO È USCITO E POI RIENTRATO, e la differenza è DOVE. Prima la
 *    pastiglia si degradava a solo-icona e diceva «31», due pastiglie più in là
 *    i conteggi per colonna dicevano «8» e «36»: quattro numeri in fila, uno dei
 *    quali senza glifo né nome accanto — «si confondono i numeri». Adesso il
 *    numero c'è solo nel gradino `name-count`, cioè solo quando ha ACCANTO il
 *    nome del progetto di cui parla, e con una scatola sua: tono più tenue,
 *    `tabular-nums`, staccato da un divisore. Un numero attaccato a un nome non
 *    è un numero che galleggia. Lo spazio l'ha liberato la coda dei conteggi
 *    (`SUMMARY_STATUSES`), non un restringimento del nome.
 *
 * L'etichetta si taglia SENZA puntini (`overflow-hidden whitespace-nowrap`
 * invece di `truncate`): a 11px l'ellissi mangia ~7px dei 34 disponibili, cioè
 * un carattere intero, per dire una cosa che il tooltip dice meglio. Il
 * `leading-tight` è l'antidoto al taglio delle code: la riga eredita
 * `leading-none` dal bottone della board, e `leading-none` + `overflow-hidden`
 * insieme tranciano le discendenti di g, p, q.
 */
function ProjectChip({ chip }: { chip: BoardProjectChip }) {
  return (
    <span
      data-testid={`board-project-${chip.projectId}`}
      // Il nome esce dal disegno ma NON dall'informazione: il tooltip resta
      // l'unico posto in cui la pastiglia dice di chi è, e senza di esso
      // un'icona sconosciuta sarebbe un enigma invece di una scorciatoia.
      title={`${chip.name}: ${chip.n} task aperti`}
      // NIENTE SUPERFICIE. Aveva fondo e angoli tondi, cioè la forma di un
      // bottone — «che non sembrino cliccabili» (Attilio, 08/08), ed era vero:
      // in una sidebar dove ogni cosa con un fondo si preme, una pastiglia con
      // un fondo promette un click che non c'è. Il raggruppamento lo fa adesso
      // la distanza (`CHIP_SPACING` doppio del gap fra i blocchi), che è come si
      // raggruppa senza disegnare un contorno.
      className="flex min-w-0 flex-shrink-0 items-center text-[11px]"
      // La larghezza viene da `chipWidth(n)`, la STESSA funzione che l'aritmetica
      // del ritaglio usa per decidere quante ce ne stanno. Con una misura fissa
      // per tutte, una pastiglia da una cifra si portava dietro 7px di vuoto in
      // coda e il divario fra due coppie cambiava col numero.
      style={{ width: chipWidth(chip.n), gap: CHIP_INNER_GAP }}
    >
      {/* Lo slot è 20×14 — l'altezza è quella standard dell'app, la larghezza
          serve ai logo-scritta. Le misure e il perché stanno accanto a
          `CHIP_W_ICON`, che è anche il numero che l'aritmetica del ritaglio
          prenota: qui si LEGGE quella costante invece di riscriverla. */}
      <span className="flex flex-shrink-0 justify-center" style={{ width: ICON_SLOT_W }}>
        <ProjectFavicon path={chip.path} size={STATUS_GLYPH_PX} width={ICON_SLOT_W} />
      </span>
      {/* Il numero c'è SEMPRE, perché una pastiglia che non può mostrarlo non
          arriva fin qui: il filtro sta a monte, in `BoardRowSummary`, e usa lo
          stesso `contaLeggibile` che dimensiona questa scatola. Prima il
          controllo era qui e lasciava passare l'icona da sola — che accanto a
          pastiglie complete si legge come un progetto con zero task. */}
      {(
        // NIENTE DIVISORE. Serviva a staccare il numero dal NOME, quando il
        // nome c'era: due testi dello stesso corpo a 4px di distanza si
        // leggevano come una parola sola. Senza nome non c'è niente da cui
        // staccarlo, e la riga verticale diventerebbe un tratto in più fra due
        // cose che nessuno confonde — un'icona e una cifra.
        // Il numero sta ATTACCATO alla sua icona, non spinto a destra.
        //
        // Era `flex-1 text-right`, e la larghezza della pastiglia è PRENOTATA
        // per due cifre: con una cifra sola il numero si trovava a ~11px
        // dall'icona invece che a 4 — e il vuoto lo faceva sembrare il numero
        // della pastiglia dopo. «I contatori sono troppo lontani dalle icone»
        // (Attilio, 08/08). Lasciando fluire il testo, il gap è sempre il
        // `gap-1` del contenitore e l'aria in eccesso finisce in coda, dove
        // separa le coppie invece di spezzarle.
        <span className="tabular-nums text-app-text-secondary">{chip.n}</span>
      )}
    </span>
  );
}

/**
 * IL RIASSUNTO DELLA RIGA «BOARD»: di chi sono i task, e a che punto stanno.
 *
 * ── Perché non una fascia che si apre ───────────────────────────────────────
 * Un accordion chiede un gesto per dire una cosa che sta in quattro numeri, e
 * quella cosa — «quanti ne ho in review, quanti stanno girando» — è esattamente
 * ciò che si vuole sapere SENZA aprire niente. La lista dei titoli, quando
 * serve, sta nella board: duplicarla nella sidebar significava tenerne due che
 * possono dire cose diverse.
 *
 * ── Le icone sono QUELLE DELLA KANBAN ───────────────────────────────────────
 * `StatusIcon` è il glifo che la board disegna sulle card e in cima alle
 * colonne: anello tratteggiato → anello vuoto → mezza torta → tre quarti →
 * disco spuntato. La stessa forma, quindi lo stesso significato, senza un
 * secondo codice da imparare. Reso alla SUA misura (nessun override di classe
 * qui): 14px, che è anche `ROW_GLYPH`, cioè la misura di ogni altro glifo di
 * riga — «tutte le icone dovrebbero avere formato standard». Ogni scostamento
 * lo manda a cavallo della griglia dei pixel, ed è così che il tratteggio del
 * backlog è già diventato poltiglia una volta (vedi `StatusIcon`).
 *
 * ── I progetti, in linea ────────────────────────────────────────────────────
 * I numeri per colonna dicono a che punto è il lavoro; non dicono DOVE. Con
 * task su cinque progetti «3 in review» è un numero che non si può agire. Le
 * pastiglie lo dicono con l'identità che il progetto ha già — la sua icona —
 * più il nome, che è ciò che resta a chi un'icona non ce l'ha. In linea e non
 * su una seconda riga («meglio mettere tutto inline», Attilio 07/08): la board
 * è UNA riga della sidebar, e una riga alta il doppio delle vicine si legge
 * come una sezione.
 *
 * ── UN SOLO MISURATO, E IL «+N» FUORI DAL RITAGLIO ──────────────────────────
 * Il contenitore esterno è l'unico elemento elastico (`flex-1 min-w-0`): la sua
 * larghezza è lo spazio RIMASTO e non dipende da cosa ci disegniamo dentro,
 * che è la condizione perché `fitBoardRow` non entri in retroazione con sé
 * stesso. Dentro, l'unico pezzo che il browser può tagliare sono le pastiglie;
 * il «+N» e i conteggi stanno FUORI da quel ritaglio, di proposito: un elemento
 * clippato a larghezza zero ha comunque un rettangolo, quindi Playwright lo
 * direbbe «visibile» mentre l'utente non vede niente.
 */
export function BoardRowSummary({ byStatus }: { byStatus: Record<TaskStatus, BoardTask[]> | undefined }) {
  const tr = useT();
  const index = useBoardProjects();
  const tutti = useMemo(() => boardProjectChips(byStatus, index), [byStatus, index]);
  /**
   * SOLO CHI HA UN'ICONA arriva sulla riga.
   *
   * Non è un filtro estetico, è la conseguenza di una regola che il progetto si
   * è già data: `ProjectFavicon` non inventa niente per chi non ha un'icona
   * vera — niente monogrammi, niente tessere generate (decisione dura, Attilio
   * 16/07). Senza il nome, una pastiglia di un progetto senza icona sarebbe uno
   * slot vuoto con una cifra accanto: la «cifra anonima» che era già il difetto
   * di due giri fa.
   *
   * Chi resta fuori NON sparisce: finisce nel «+N» insieme a chi non ci sta per
   * spazio, che è esattamente ciò che quel numero dichiara — «altri N progetti».
   *
   * Il filtro sta PRIMA dell'aritmetica, non dentro il disegno, se no si
   * prenoterebbe spazio per pastiglie che poi non si disegnano. E la risposta
   * arriva sincrona per ogni progetto che la cache conosce, quindi al ricarico
   * la riga nasce già composta invece di ricomporsi sotto gli occhi.
   */
  const conIcona = useProjectIconsPresent(useMemo(() => tutti.map((c) => c.path), [tutti]));
  const chips = useMemo(
    // DUE condizioni, non una: serve l'icona (è l'unica identità che la
    // pastiglia mostra) E un conteggio che ci stia per intero. «Non dovremmo
    // mostrare un'icona se non si riesce a vedere completamente il suo
    // conteggio» — un'icona senza numero non dice ciò per cui questa riga
    // esiste, e accanto a pastiglie complete si legge come «zero task».
    () => tutti.filter((c) => c.path && conIcona.has(c.path) && contaLeggibile(c.n)),
    [tutti, conIcona],
  );
  /** Quelli tolti dal filtro: il «+N» li deve contare, o la riga direbbe che i
   *  progetti con lavoro aperto sono meno di quanti sono. */
  const senzaIcona = tutti.length - chips.length;
  const counts = useMemo(
    () => SUMMARY_STATUSES
      .map((status) => ({ status, n: byStatus?.[status]?.length ?? 0 }))
      .filter((c) => c.n > 0),
    [byStatus],
  );

  // `null` = non ancora misurato, ed è un valore DIVERSO da 0. Zero è una
  // misura vera («qui non c'è spazio») e va annunciata col «+N»; null è
  // silenzio legittimo, il fotogramma prima che il layout esista.
  const [width, setWidth] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  /**
   * L'OSSERVATORE SI AGGANCIA CON UNA REF-FUNZIONE, non con un effetto a
   * dipendenze vuote. La differenza non è di stile: è la ragione per cui sul
   * desktop le pastiglie non comparivano MAI.
   *
   * Questo componente esce con `return null` finché non c'è né un progetto né
   * un conteggio — cioè al primo giro, prima che i task arrivino dal server. In
   * quel giro il `<div>` misurato non esiste, quindi un `useEffect(…, [])`
   * trovava `ref.current` a null, usciva subito, e non veniva più rieseguito:
   * quando i dati atterravano il nodo nasceva senza nessuno che lo guardasse.
   * `width` restava `null` per sempre e `fitProjectChips` — che a `null` tace di
   * proposito — non disegnava niente. Sul telefono il difetto era invisibile
   * perché il cassetto si monta DOPO i dati, quindi il primo giro aveva già i
   * conteggi: lo stesso codice, due comportamenti, decisi da chi arriva prima.
   *
   * Una ref-funzione viene chiamata da React ogni volta che il nodo entra o
   * esce, quindi l'aggancio non può perdersi qualunque sia l'ordine.
   */
  const measureRef = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // La larghezza si legge dall'osservatore e basta: una lettura sincrona qui
    // dentro sarebbe una scrittura di stato in montaggio, e l'osservatore
    // consegna comunque la prima misura appena il layout è pronto.
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setWidth((prev) => (prev !== null && Math.abs(prev - w) < 1 ? prev : w));
    });
    ro.observe(el);
    observer.current = ro;
  }, []);

  const fitted = fitBoardRow(width, chips, counts);
  const { rolled } = fitted.counts;
  // Il «+N» somma DUE esclusioni diverse — chi non ci sta per spazio e chi non
  // ha un'icona da mostrare — perché per chi guarda sono la stessa cosa: altri
  // progetti con lavoro aperto, che questa riga non sta nominando.
  const nascosti = fitted.chips.hidden + senzaIcona;
  // La riga esiste se c'è QUALCOSA da dire, e i progetti senza icona sono
  // qualcosa: `tutti`, non `chips`, o un insieme di progetti tutti senza icona
  // farebbe sparire anche i conteggi di stato che gli stanno accanto.
  if (tutti.length === 0 && counts.length === 0) return null;

  return (
    <div
      ref={measureRef}
      data-testid="board-row-summary"
      // UN PASSO SOLO fra i tre gruppi — etichetta della board, pastiglie dei
      // progetti, conteggi di stato — ed è lo stesso che separa due pastiglie.
      // Prima erano due (6 fra i blocchi, 12 fra le pastiglie) più un `ml-auto`
      // che spingeva i conteggi a destra: la distanza fra i gruppi dipendeva
      // dallo spazio che avanzava, cioè cambiava a ogni progetto in più.
      // «Teniamo spaziatura uniforme fra board, conteggio progetti e conteggi
      // stati» (Attilio, 08/08).
      className="flex min-w-0 flex-1 items-center"
      // IL MARGINE SINISTRO NON È UN VEZZO: l'etichetta «Board» sta FUORI da
      // questo contenitore — è un fratello, dentro il bottone della riga, che
      // ha il suo `gap-2`. Spaziare qui dentro non poteva quindi allontanare i
      // progetti dall'etichetta, ed è per questo che «ancora non c'è spazio fra
      // board, progetti e status»: due dei tre gruppi non erano nemmeno nello
      // stesso flex. Il margine recupera la differenza fino a `GROUP_SPACING`,
      // così il primo stacco vale quanto il secondo.
      style={{ gap: GROUP_SPACING, marginLeft: GROUP_SPACING - BOARD_ROW_GAP }}
    >
      {/* IL GRUPPO DEI PROGETTI: le pastiglie e il loro «+N».
          Il «+N» stava fuori, a `GROUP_SPACING` dalle pastiglie — «il conteggio
          dei progetti che non si vedono è troppo distante» (Attilio, 08/08), e
          giustamente: parla DI LORO, quindi appartiene al loro gruppo e sta al
          loro passo. Fuori resta solo il confine col gruppo dei conteggi. */}
      <div className="flex min-w-0 items-center" style={{ gap: CHIP_SPACING }}>
      <div
        // Il nome NON comincia per `board-project-`, ed è deliberato: BOARD-14
        // ancora la pastiglia con un locator a PREFISSO
        // (`[data-testid^="board-project-"]`) e prende il primo in ordine di
        // DOM. Finché il contenitore si chiamava `board-project-chips` il primo
        // era LUI — un elastico largo per costruzione — quindi il test misurava
        // la scatola invece del contenuto e sarebbe rimasto verde con zero
        // pastiglie dentro. Chiamandolo altrimenti, `.first()` cade sulla
        // pastiglia vera, e a zero pastiglie cade sul «+N» (largo ~16px), che è
        // sotto la soglia del test: il rosso c'è davvero.
        data-testid="board-chips-clip"
        // L'unico pezzo tagliabile della riga, e comunque già dimensionato
        // dall'aritmetica: l'`overflow-hidden` qui è la rete, non il piano.
        //
        // NON `flex-1`: l'elastico è il contenitore ESTERNO, e se lo fosse anche
        // questo si allargherebbe fino a spingere il «+N» contro i conteggi —
        // cioè il ritaglio delle pastiglie si leggerebbe come parte dei numeri
        // di stato. Lo spazio che avanza se lo prende il `ml-auto` dei
        // conteggi, così il «+N» resta attaccato a ciò che sta ritagliando.
        // Il passo fra le pastiglie viene dalla COSTANTE, non da una classe
        // Tailwind: è lo stesso numero che `fitProjectChips` usa per decidere
        // quante ce ne stanno, e due copie divergerebbero — la riga si
        // disegnerebbe con un passo diverso da quello prenotato, cioè
        // sborderebbe o lascerebbe un buco. (Tailwind scansiona il sorgente come
        // TESTO, quindi una classe composta da una variabile non genererebbe
        // nemmeno il CSS.)
        className="flex min-w-0 items-center overflow-hidden"
        style={{ gap: CHIP_SPACING }}
      >
        {fitted.chips.shown.map((chip) => (
          <ProjectChip key={chip.projectId} chip={chip} />
        ))}
      </div>
      {/* Il ritaglio è DICHIARATO — «+2» — invece di lasciar sparire dei
          progetti dietro un `overflow: hidden`. Lo spazio se lo prende sempre
          `fitProjectChips` (secondo passaggio), quindi comparire non sposta
          nulla; l'elemento invece esiste solo quando ha qualcosa da dire. */}
      {nascosti > 0 && (
        <span
          data-testid="board-project-more"
          title={tr('board.projects.more', { n: nascosti })}
          className="flex-shrink-0 tabular-nums text-[11px] text-app-text-tertiary"
        >
          +{nascosti}
        </span>
      )}
      </div>
      {(fitted.counts.shown.length > 0 || rolled) && (
        <span
          // `ml-auto`: i conteggi si appoggiano al BORDO DESTRO della riga.
          //
          // Era stato tolto per rendere uniformi i tre stacchi, ma la riga è
          // `flex-1` e lo spazio che avanza deve pur finire da qualche parte:
          // senza `ml-auto` finiva DOPO i conteggi — «hanno spazio a destra che
          // non dovrebbero avere» (Attilio, 08/08). Con l'auto quello spazio
          // torna PRIMA di loro, dove si legge come lo stacco fra due gruppi
          // invece che come una coda vuota. `GROUP_SPACING` resta comunque il
          // minimo garantito dall'aritmetica del ritaglio: l'auto può solo
          // allargarlo, mai stringerlo.
          className="ml-auto flex flex-shrink-0 items-center gap-1.5"
          data-testid="board-status-counts"
        >
          {fitted.counts.shown.map(({ status, n }) => (
            <span
              key={status}
              data-testid={`board-count-${status}`}
              title={`${STATUS_LABEL[status]}: ${n}`}
              className="flex items-center gap-1 tabular-nums text-[11px] text-app-text-secondary"
            >
              <StatusIcon status={status} />
              {n}
            </span>
          ))}
          {rolled && (
            <span
              data-testid="board-count-rest"
              title={rolled.statuses.map((s) => `${STATUS_LABEL[s]}: ${counts.find((c) => c.status === s)?.n ?? 0}`).join(' · ')}
              className="flex items-center gap-1 tabular-nums text-[11px] text-app-text-tertiary"
            >
              <MoreHorizontal className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {rolled.n}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
