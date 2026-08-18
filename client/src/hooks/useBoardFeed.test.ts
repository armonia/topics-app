import { describe, expect, test, afterEach, beforeEach, jest } from 'bun:test';
import { createElement, useEffect } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mount } from '../test/reactHarness';
import { boardApi, type BoardTask } from '../lib/board';
import { dispatchLifecycle } from '../lib/wsFrameBus';
import { useBoardFeed, type BoardFeed } from './useBoardFeed';

/**
 * ONE READER OF THE GLOBAL FEED, AND IT NEVER READS OUT OF ORDER.
 *
 * `GET /api/all-boards/tasks` was measured on 2026-08-15 on this machine at 467
 * root tasks, 1,435,735 bytes, 145 ms. Three independent surfaces re-issued it
 * on every `task:*` event and only one of them coalesced, so a burst of ten
 * agent moves cost tens of megabytes and left the slowest answer on screen.
 *
 * QUESTO FILE ERA NOVE `readFileSync(...).includes(...)`: le due proprietà che
 * costano davvero — l'inversione fra due letture e il risveglio dopo un
 * reconnect — non le eseguiva nessuno, e due delle nove guardie passavano
 * comunque (`/\} finally \{[\s\S]{0,800}?flushDeferredRead\(\)/` matcha
 * QUALUNQUE `finally` in un file da 2.000 righe). Adesso l'hook gira davvero,
 * col renderer di `test/reactHarness` e i timer finti: jsdom non è una
 * dipendenza di questo progetto e `renderToStaticMarkup` non ha un secondo
 * render, che è dove queste due cose vivono.
 *
 * Restano tre guardie sul sorgente, e solo dove il comportamento NON si può
 * eseguire da qui: riguardano `KanbanBoardPane.tsx` e `StandaloneChatGroup.tsx`,
 * che importano `@/lib/…` — un alias che `bun test` non risolve (stessa ragione
 * dichiarata in `Board/Card.test.ts` e `GlobalCapControl.test.tsx`), quindi
 * quelle superfici qui non si montano.
 */
const dir = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(join(dir, rel), 'utf8');

/** Una lettura in volo: la si fa atterrare quando serve, nell'ordine che serve. */
interface Pending {
  projectId: string;
  archived: boolean;
  resolve: (rows: BoardTask[]) => void;
  reject: (e: Error) => void;
}

function task(id: string): BoardTask {
  // Solo i campi che il test guarda: `BoardTask` ne ha 60 e nessuno di essi
  // entra nella decisione sotto esame.
  return { id, text: id } as unknown as BoardTask;
}

const realList = boardApi.list;
let pending: Pending[] = [];

/** Fa girare le micro-task in coda (le `then` del `latestWins`) senza timer. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  jest.useFakeTimers();
  pending = [];
  boardApi.list = ((projectId: string, _status?: unknown, _labels?: unknown, opts?: { archived?: boolean }) =>
    new Promise((resolve, reject) => {
      pending.push({ projectId, archived: opts?.archived === true, resolve, reject });
    })) as typeof boardApi.list;
});

afterEach(() => {
  jest.useRealTimers();
  boardApi.list = realList;
});

/**
 * Monta l'hook su una board che si può cambiare da fuori, come fa la pane
 * quando l'utente passa a un altro progetto (o apre l'archivio).
 */
function mountFeed(first: { projectId: string; showArchived?: boolean }) {
  // La sonda pubblica ciò che ha in mano da un EFFETTO, non dal corpo del
  // render: scrivere fuori durante il render è un effetto collaterale, e le
  // regole dei hook lo vietano (giustamente — qui poi girerebbe due volte).
  const box: { query: { projectId: string; showArchived: boolean }; feed: BoardFeed | null } = {
    query: { projectId: first.projectId, showArchived: first.showArchived === true },
    feed: null,
  };
  const errors: Array<string | null> = [];
  const Probe = (): null => {
    const feed = useBoardFeed({
      mode: 'project',
      projectId: box.query.projectId,
      showArchived: box.query.showArchived,
      onError: (m) => { errors.push(m); },
    });
    useEffect(() => { box.feed = feed; });
    return null;
  };
  const h = mount(createElement(Probe));
  return {
    now: (): BoardFeed => box.feed!,
    errors,
    setQuery(next: { projectId?: string; showArchived?: boolean }) {
      box.query = { ...box.query, ...next };
      h.rerender();
    },
    unmount: () => h.unmount(),
  };
}

describe('useBoardFeed: la risposta è di CHI ha chiesto per ultimo', () => {
  /**
   * IL GUASTO. Due letture si sovrappongono (cambio board, o un burst di
   * eventi) e tornano invertite: senza la guardia vince chi scrive per ultimo,
   * cioè la PIÙ VECCHIA, e sullo schermo resta la board di prima — con nessun
   * evento successivo che la corregga, perché l'evento è già passato.
   */
  test('due letture invertite: resta quella chiesta per ULTIMA', async () => {
    const f = mountFeed({ projectId: 'board-A' });
    expect(pending.length).toBe(1);
    expect(pending[0]!.projectId).toBe('board-A');
    expect(f.now().loading).toBe(true);

    // Si cambia board mentre la prima è ancora in volo. La finestra del
    // coalescer è aperta, quindi la seconda parte alla sua chiusura.
    f.setQuery({ projectId: 'board-B' });
    expect(pending.length).toBe(1);
    jest.advanceTimersByTime(400);
    expect(pending.length).toBe(2);
    expect(pending[1]!.projectId).toBe('board-B');

    // Arrivano invertite: prima la SECONDA…
    pending[1]!.resolve([task('b1'), task('b2')]);
    await settle();
    expect(f.now().tasks.map((t) => t.id)).toEqual(['b1', 'b2']);
    expect(f.now().loading).toBe(false);

    // …e poi la prima, che è la risposta a una domanda che non è più questa.
    pending[0]!.resolve([task('a1')]);
    await settle();
    expect(f.now().tasks.map((t) => t.id), 'la lettura superata ha riscritto sopra').toEqual(['b1', 'b2']);
    // E non riapre lo spinner: `loading` è derivato dalla chiave della risposta.
    expect(f.now().loading).toBe(false);
    f.unmount();
  });

  /**
   * L'altra metà: anche un FALLIMENTO superato deve tacere. Un errore che
   * atterra sopra una lista buona lascia la board giusta sotto una riga rossa
   * che non riguarda più niente.
   */
  test('un fallimento superato non scrive il suo errore sopra una risposta buona', async () => {
    const f = mountFeed({ projectId: 'board-A' });
    f.setQuery({ projectId: 'board-B' });
    jest.advanceTimersByTime(400);
    expect(pending.length).toBe(2);

    pending[1]!.resolve([task('b1')]);
    await settle();
    expect(f.errors.at(-1)).toBeNull();

    pending[0]!.reject(new Error('boom'));
    await settle();
    expect(f.errors.at(-1), "l'errore della lettura superata è arrivato in cima").toBeNull();
    expect(f.now().tasks.map((t) => t.id)).toEqual(['b1']);
    f.unmount();
  });

  /**
   * L'ARCHIVIO È UN'ALTRA DOMANDA, non un filtro: la chiave della lettura porta
   * anche quello. Senza, la risposta della board viva chiudeva lo spinner
   * dell'archivio mostrando le righe sbagliate.
   */
  test('la chiave della lettura distingue archivio e vivi', async () => {
    const f = mountFeed({ projectId: 'board-A' });
    f.setQuery({ showArchived: true });
    jest.advanceTimersByTime(400);
    expect(pending.length).toBe(2);
    expect(pending[1]!.archived).toBe(true);

    // Risponde per prima la lettura dei VIVI, che è ormai superata.
    pending[0]!.resolve([task('vivo')]);
    await settle();
    expect(f.now().tasks).toEqual([]);
    expect(f.now().loading, "una risposta di un'altra domanda ha chiuso lo spinner").toBe(true);

    pending[1]!.resolve([task('archiviato')]);
    await settle();
    expect(f.now().tasks.map((t) => t.id)).toEqual(['archiviato']);
    expect(f.now().loading).toBe(false);
    f.unmount();
  });

  /**
   * UN RECONNECT È UN BUCO, NON UNA PAUSA: i `task:*` trasmessi mentre il
   * socket era giù arrivano a un socket che non esiste più e nessuno li
   * ripete. Senza questa rilettura la board resta com'era prima del riavvio
   * finché qualcos'altro non si muove.
   */
  test('il ritorno del WebSocket rilegge; e senza di lui non rilegge nessuno', async () => {
    const f = mountFeed({ projectId: 'board-A' });
    pending[0]!.resolve([task('vecchia')]);
    await settle();
    // La finestra del coalescer si chiude senza code: da qui in poi una
    // lettura in più può venire solo da un evento.
    jest.advanceTimersByTime(400);
    expect(pending.length).toBe(1);

    // Controllo negativo: un 'close' non è un ritorno, e non deve leggere.
    dispatchLifecycle('close');
    jest.advanceTimersByTime(400);
    expect(pending.length, 'ha riletto su un evento che non è il ritorno').toBe(1);

    dispatchLifecycle('open');
    expect(pending.length).toBe(2);
    pending[1]!.resolve([task('fresca')]);
    await settle();
    expect(f.now().tasks.map((t) => t.id)).toEqual(['fresca']);
    f.unmount();
  });

  /**
   * FINIRE IL GESTO NON È LEGGERE. `endDrag` rilasciava la GET parcheggiata
   * durante il drag, e la pane lo chiama PRIMA della PATCH del drop: la lettura
   * partiva prima della scrittura, tornava con lo stato di partenza e riportava
   * la card nella colonna di prima per un giro di rete intero.
   */
  test('la lettura parcheggiata durante il drag esce con flushDeferredRead, non con endDrag', async () => {
    const f = mountFeed({ projectId: 'board-A' });
    pending[0]!.resolve([task('t1')]);
    await settle();
    jest.advanceTimersByTime(400);
    expect(pending.length).toBe(1);

    f.now().beginDrag();
    f.now().refetch();
    expect(pending.length, 'ha letto con la card in mano').toBe(1);

    f.now().endDrag();
    jest.advanceTimersByTime(400);
    expect(pending.length, 'la lettura è partita alla fine del gesto, prima della PATCH').toBe(1);

    f.now().flushDeferredRead();
    expect(pending.length).toBe(2);
    // E una seconda chiamata non ne fa partire un'altra: la coda era una sola.
    f.now().flushDeferredRead();
    expect(pending.length).toBe(2);
    f.unmount();
  });

  /**
   * E le righe restano ferme finché la card è in mano: sostituirle sotto il
   * puntatore fa scattare il layout e il gesto salta.
   */
  test('durante il drag le righe non cambiano, ma la patch ottimistica sì', async () => {
    const f = mountFeed({ projectId: 'board-A' });
    pending[0]!.resolve([task('t1'), task('t2')]);
    await settle();
    jest.advanceTimersByTime(400);

    // Una lettura partita PRIMA del gesto: è l'unica che può atterrare mentre
    // la card è in mano (quelle chieste dopo restano parcheggiate).
    f.now().refetch();
    expect(pending.length).toBe(2);
    f.now().beginDrag();
    pending[1]!.resolve([task('t9')]);
    await settle();
    expect(f.now().tasks.map((t) => t.id), 'le righe sono cambiate sotto il puntatore').toEqual(['t1', 't2']);

    // La mossa da tastiera scrive DENTRO il gesto: quella deve vedersi.
    f.now().patchTask('t2', { status: 'done' });
    expect(f.now().tasks.map((t) => t.status)).toEqual([undefined as never, 'done']);

    f.now().endDrag();
    expect(f.now().tasks.map((t) => t.id)).toEqual(['t9']);
    f.unmount();
  });
});

/**
 * Le tre superfici qui sotto non si montano da `bun test` (alias `@/`), quindi
 * di loro resta il controllo sul sorgente: chi ha il diritto di leggere il feed.
 */
describe('il feed globale ha un lettore solo', () => {
  test('the board pane does not read the global feed itself', () => {
    // `useGlobalBoard` already owns and coalesces exactly this feed and
    // publishes it in `boardTasksStore`. A second reader is a second answer.
    const s = src('../components/Board/KanbanBoardPane.tsx');
    expect(s.includes('boardApi.listAll(')).toBe(false);
    // The project/archive read stays local (nobody else wants it), but it goes
    // through the same hook, so the coalescing and the ordering guard are not
    // something the next edit can forget.
    expect(s.includes('boardApi.list(')).toBe(false);
    expect(s.includes('useBoardFeed(')).toBe(true);
  });

  test('the topic → task index derives from the store, it does not fetch', () => {
    // Mounted unconditionally in App: its fetch fired App-wide on every task
    // event, uncoalesced, and could install a superseded snapshot into the
    // shared chat store.
    const s = src('./useTaskTopicIndex.ts');
    expect(s.includes('boardApi.')).toBe(false);
    expect(s.includes('useBoardTasks(')).toBe(true);
  });

  test('e chi scrive la rilascia quando la PATCH ha risposto, non prima', () => {
    const pane = src('../components/Board/KanbanBoardPane.tsx');
    // Il `finally` di `dropTo` e nessun altro: la vecchia regex accettava
    // QUALUNQUE `finally` seguito, entro 800 caratteri, da un
    // `flushDeferredRead()` — in un file da 2.000 righe non poteva fallire.
    const from = pane.indexOf('const dropTo');
    expect(from, 'dropTo è sparito dalla pane').toBeGreaterThan(-1);
    const body = pane.slice(from, pane.indexOf('\n  }, [', from));
    expect(/\} finally \{[\s\S]*?flushDeferredRead\(\)/.test(body)).toBe(true);
    // …e la gesture che NON produce una scrittura non deve lasciarla appesa.
    expect(pane.includes('else flushDeferredRead()')).toBe(true);
  });

  test('una lista atterrata durante la scrittura non riporta indietro il drop', () => {
    // La regola è pura e provata in `lib/boardOrder.test.ts`
    // (`applyPendingWrites`): qui si guarda che la pane la applichi davvero fra
    // il feed e le colonne.
    const pane = src('../components/Board/KanbanBoardPane.tsx');
    expect(pane).toContain('applyPendingWrites(feedTasks, pendingWrites)');
    expect(pane).toContain('setPendingWrites(');
  });

  test('the general board gets a STABLE onOpenTopic, like the project one', () => {
    // An inline arrow here is a new prop identity on every parent render, which
    // defeats the memo on every card of the board. Asserzione POSITIVA: la prop
    // dev'essere un identificatore (una `useCallback` con un nome), non
    // «qualcosa che non comincia con una parentesi» — che era vero per
    // qualunque espressione.
    const s = src('../components/Layout/StandaloneChatGroup.tsx');
    const prop = /onOpenTopic=\{([^}]*)\}/.exec(s);
    expect(prop, 'onOpenTopic è sparito dalla board generale').not.toBeNull();
    expect(prop![1]!.trim()).toMatch(/^[A-Za-z_$][\w$]*$/);
    // E quel nome è memoizzato dove è dichiarato.
    expect(s).toContain(`const ${prop![1]!.trim()} = useCallback(`);
  });
});
