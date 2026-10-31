/**
 * The window mounts full cards nearby and keeps lightweight sortable targets for the rest.
 *
 * This source guard mirrors `GlobalCapControl.test.tsx` and `ThreadRuns.test.tsx`:
 * `Card.tsx` imports `@/lib/popoverStyles`, which `bun test` cannot resolve, so
 * this test cannot mount the column. Reverting to a full `tasks.map` would leave
 * behavior intact while silently restoring the large DOM tree.
 *
 * @covers KANBAN-01
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Card.tsx'), 'utf8');
const virtualized = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'VirtualizedCards.tsx'), 'utf8');
/** The live chips (retry wait, running tool, ticking effort) live next door,
 *  in `CardLive.tsx`: the card only decides WHICH one it draws. */
const live = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'CardLive.tsx'), 'utf8');

describe('il corpo della colonna', () => {
  test('mantiene le pagine di Review e Done e virtualizza le corsie di lavoro grandi', () => {
    expect(src).toContain('columnSlice(');
    expect(src).toContain('slice.rows.map(');
    expect(src).toContain("status === 'backlog' || status === 'todo' || status === 'in_progress'");
    expect(src).toContain('<VirtualizedCards');
    expect(virtualized).toContain('VIRTUAL_FULL_RENDER_LIMIT = 25');
  });

  test('SortableContext riceve tutti gli id, anche quelli fuori dalla finestra', () => {
    // Offscreen ids stay as lightweight sortable nodes, so keyboard and collision still have targets.
    const idsKey = src.slice(src.indexOf('const idsKey'), src.indexOf('\n', src.indexOf('const idsKey')));
    expect(idsKey).toContain('sortableRows');
    expect(src).toContain('const sortableRows = virtualized ? tasks : slice.rows;');
    expect(virtualized).toContain('function SortablePlaceholder');
    expect(virtualized).toContain('visibleVirtualIds(rows, viewport.top');
  });

  test('la coda dice quante card restano e come tirarle su', () => {
    // Una colonna tagliata in silenzio è una colonna che sembra senza storia.
    expect(src).toContain('kanban-column-more-');
    expect(src).toContain('setShown((n) => n + COLUMN_PAGE)');
  });

  test('il contatore in testa resta il TOTALE, non la fetta', () => {
    // Il numero accanto al nome della colonna risponde a «quanti ce ne sono»,
    // non a «quanti se ne vedono».
    expect(src).toContain('{tasks.length}');
  });
});

/**
 * UNO SCADUTO NON SI DISEGNA COME UN ROSSO.
 *
 * `checks_state` ha tre esiti dal 18/08 (`checksVerdict` in
 * `server/services/review-checks.ts`) e la card deve tenerli distinti: rosso
 * dice «il codice e' rotto, non approvare», ambra dice «non lo sappiamo».
 * Misurato lo stesso giorno sul DB vivo: delle 15 card marcate `fail`, SEI
 * erano solo scadute al tetto dei 20 minuti — il 40% delle bocciature accusava
 * un codice sano.
 *
 * Sorgente e non render, per la stessa ragione dei casi qui sopra: `Card.tsx`
 * importa `@/lib/popoverStyles` e `bun test` non risolve l'alias. Cio' che si
 * sorveglia e' che i due chip restino DUE, con predicati disgiunti — collassare
 * `checksUnknown` dentro `checksRed` e' una modifica di una parola e non fa
 * rumore da nessuna parte.
 */
describe('il chip dei checks distingue rosso da non-misurato', () => {
  test('i due predicati esistono e sono disgiunti', () => {
    expect(src).toContain("const checksRed = task.checksState === 'fail';");
    expect(src).toContain("const checksUnknown = task.checksState === 'unknown';");
  });

  test("il chip «non misurati» ha un suo testid e un suo colore", () => {
    // Il testid serve all'E2E; il colore e' la meta' che l'occhio legge, e
    // riusare `rose` avrebbe rimesso in piedi il difetto lasciando i test verdi.
    expect(src).toContain('data-testid="card-checks-unknown"');
    const chip = src.slice(src.indexOf('data-testid="card-checks-unknown"'));
    expect(chip.slice(0, 400)).toContain('amber');
    expect(chip.slice(0, 400)).not.toContain('rose');
  });

  test('entrambi entrano nella riga dei chip: un chip che non si disegna non esiste', () => {
    // `hasMetaRow` decide se la riga si monta affatto. Dimenticarlo li' vuol
    // dire un chip corretto e invisibile — il difetto piu' silenzioso di tutti.
    const meta = src.slice(src.indexOf('const hasMetaRow'), src.indexOf('const hasMetaRow') + 700);
    expect(meta).toContain('checksRed');
    expect(meta).toContain('checksUnknown');
  });
});


/**
 * IL CHIP DEL TRIAGE, cioè i minuti in cui la card sembra ferma.
 *
 * Il primo turno di un agente comincia dall'inquadrare il lavoro: legge la
 * card, riscrive il titolo grezzo, giudica la priorità. Per chi guarda la board
 * non cambia niente — stesso titolo, nessun commento — e l'unica cosa che si
 * muove è un cronometro.
 *
 * Sorgente e non render, per la stessa ragione degli altri casi di questo file.
 * Ciò che si sorveglia sono le DUE condizioni insieme: il chip appartiene a un
 * turno vivo (`dispatchState === 'working'`) e alla fase iniziale (`triage`).
 * Perderne una lascerebbe il chip acceso su una card che non sta lavorando.
 */
/**
 * THE DEAD TURN THE DISPATCHER RETRIES, AND WHAT IT IS DOING RIGHT NOW.
 *
 * During a provider outage (2026-09-03) every stalled card said "working" with
 * the stopwatch climbing: the retry branch never moves the chip, and the client
 * dropped the live entry only on a `task:updated` that never came. The wait
 * rides the live event (`retry`) and takes the stopwatch's place; the running
 * tool (`lastTool`) sits under the foot. Source, not render, for the reason
 * written at the top of this file.
 *
 * Two files: the GATES (which chip, under which condition) are the card's and
 * are read from `Card.tsx`; the chips themselves are read from `CardLive.tsx`,
 * and the card must mount them, or a chip that exists is a chip nobody sees.
 */
describe('the wait before a retry and the running tool', () => {
  test('the stopwatch does NOT run during a retry wait: the live chip excludes `retry`', () => {
    expect(src).toContain("live && !live.retry && task.dispatchState === 'working' ? (");
    expect(src).toContain("live?.retry && task.dispatchState === 'working' && (");
    expect(src).toContain('<RetryWaitChip retry={live.retry}');
    expect(live).toContain('data-testid="card-retry-wait"');
  });

  test('"Retry now" goes through the comments door, which is the existing resume', () => {
    expect(live).toContain('data-testid="card-retry-now"');
    expect(live).toContain('export const RETRY_NOW_MESSAGE');
    expect(src).toContain('onRetryNow={() => steer(RETRY_NOW_MESSAGE)}');
  });

  test('the running tool is drawn ONCE: the progress line carries it, and the card has no second tool line', () => {
    // The progress line is the only place the tool's name and input are printed.
    expect(src).toContain("const progressLine = live?.lastTool && !live.retry && task.dispatchState === 'working'");
    expect(src).toContain('`${live.lastTool.name}');
    // A second `<LiveToolLine>` in the card would print «Bash · bun run test:unit» twice.
    expect(src).not.toContain('<LiveToolLine');
    expect(src).not.toContain('card-live-tool');
    expect(live).toContain('export function LiveToolLine');
  });
});

/**
 * A PARKED CARD SAYS WHY, AND OFFERS THE WAY BACK.
 *
 * The reason lived in the chip's tooltip (invisible on touch) and the only
 * gesture was guessing that a drag to Todo restarts it. The line is printed and
 * the choice row makes the same PATCH the drag makes.
 */
describe('the parked card', () => {
  test('prints dispatchError as a line and draws the park choices', () => {
    expect(src).toContain("choiceState === 'parked' && (");
    expect(src).toContain('data-testid="card-dispatch-error"');
    const block = src.slice(src.indexOf("choiceState === 'parked' && ("));
    expect(block.slice(0, 1200)).toContain('<TaskChoiceRow task={task}');
  });
});

/**
 * THE AGENT'S WORD ON A CARD IN PROGRESS: the last one, under the checklist,
 * with the review's fold. The block used to be gated on `status === 'review'`,
 * and in progress the card was a stopwatch.
 */
describe('the progress word', () => {
  test('in lavorazione mostra una riga sola, mai il testo intero', () => {
    expect(src).toContain('data-testid="card-progress-line"');
    const block = src.slice(src.indexOf('data-testid="card-progress-word"'));
    expect(block.slice(0, 500)).toContain('truncate');
    expect(block.slice(0, 500)).not.toContain('line-clamp-[10]');
  });

  test('la nota di sistema e\' ripiegata sotto «mostra», mai sola nel corpo', () => {
    const fold = src.slice(src.indexOf('function SystemNoteFold'), src.indexOf('const CardBody = memo'));
    expect(fold).toContain('data-testid="card-system-note-toggle"');
    expect(fold).toContain("tr('board.card.noteShow')");
    expect(fold).toContain('{aperta && (');
    // Progress and review both use it: one implementation, two call sites.
    expect(src.split('<SystemNoteFold note={lastComment} />').length - 1).toBe(2);
  });
});

/**
 * ONE LINE OF TEXT FOR THE MEASURE: model with its provider, time and tokens.
 *
 * It sits on the card in progress and in review, always visible, and never as
 * a pill. At 300 px it is cut from the tail: tokens go before the model does.
 */
describe('la misura del turno sulla card', () => {
  test('in lavorazione la riga viva c\'e\': niente chip, solo testo e il caricamento di main', () => {
    expect(src).not.toContain("task.status === 'in_progress' ? null");
    expect(src).toContain('<LiveEffortChip usage={live} label={modelLine} />');
    expect(live).toContain('data-testid="card-measure"');
    // The live dot is main's SparkLoader now, not a sky pulse dot.
    expect(live).toContain("import { SparkLoader } from '../Layout/StreamingIndicator';");
    expect(live).toContain('<SparkLoader className="shrink-0" />');
    expect(live).not.toContain('animate-pulse rounded-full bg-sky-400');
    expect(live).not.toContain('bg-sky-500/15');
  });


  test('il modello e il provider sono nel CONTENUTO della riga, non solo nel titolo', () => {
    // Guard against the model moving into `title` alone: the visible text must carry it.
    expect(src).toContain('>{modelLine}{(task.agentMs > 0 || costo > 0)');
    expect(live).toContain('{label ?? fmtModel(usage.model)} · ⏱ {fmtLive(ms)}');
  });

  test('a 300 px non va in overflow: si accorcia dalla coda, prima i token', () => {
    const start = src.indexOf('data-testid="card-measure"');
    expect(start).toBeGreaterThan(-1);
    const span = src.slice(start, start + 400);
    expect(span).toContain('min-w-0');
    expect(span).toContain('max-w-full');
    expect(span).toContain('truncate');
    // Tokens come AFTER the time in the text, so truncation drops them first.
    const content = src.slice(src.indexOf('>{modelLine}{(task.agentMs > 0'), src.indexOf('{/* THE DOLLARS'));
    expect(content.indexOf('fmtMs(task.agentMs)')).toBeLessThan(content.indexOf('fmtTok(costo)'));
    expect(live).toContain('min-w-0 truncate');
  });

  test('il piede non ha pillole impilate: la misura non porta sfondo', () => {
    const start = src.indexOf('data-testid="card-measure"');
    expect(src.slice(start, start + 400)).not.toContain('bg-white/10');
  });
});

/**
 * IN REVIEW THE BODY HOLDS THE AGENT'S WORD; THE NOTE STAYS FOLDED.
 *
 * The card's last voice is often the dispatcher's note ("Live preview ready").
 * The body must not draw it with its tag: it keeps the agent's last sentence,
 * and the note waits behind a show toggle.
 */
describe('la review: parola dell\'agente nel corpo', () => {
  test('il corpo usa la parola dell\'agente quando l\'ultima voce è di sistema', () => {
    expect(src).toContain('const bodyWord = notesOfMachine ? agentWord : lastComment;');
    expect(src).toContain('<ChatMarkdown components={{}}>{questionToProse(bodyWord.content)}</ChatMarkdown>');
  });

  test('il tag «SISTEMA» in chiaro nel corpo e\' stato tolto', () => {
    expect(src).not.toContain('card-comment-system-tag');
  });
});

describe('il chip del triage', () => {
  test('si disegna solo su un turno VIVO e ancora in inquadramento', () => {
    expect(src).toContain("live?.triage && !live.retry && task.dispatchState === 'working'");
    expect(src).toContain('data-testid="card-triage"');
  });

  test('ha un testo suo, non un titolo inventato nel markup', () => {
    const chip = src.slice(src.indexOf('data-testid="card-triage"'));
    expect(chip.slice(0, 400)).toContain("tr('board.card.triage')");
    expect(chip.slice(0, 400)).toContain("tr('board.card.triageTitle')");
  });
});

/** MSEL-01: «· via Topics» reads the providers snapshot. Read with
 *  `getProvidersSnapshotState()` inside the memo'd card, a cold load into the
 *  board judged a snapshot still null and the label stayed missing until the
 *  card happened to re-render. The card subscribes to the boolean it draws. */
describe('the card route label', () => {
  test('subscribes to the snapshot instead of reading it once during render', () => {
    expect(src).toContain('useSyncExternalStore(subscribeProvidersSnapshot,');
  });
});

describe('the card is the containing block of its frost', () => {
  test('the card root is positioned whether or not a freeze is on', () => {
    // `SwapIce` mounts `absolute inset-0` boxes in every card and positions
    // the card (`.swap-ice-host`) only while frozen. Without `relative` on the
    // root, each idle card's empty glints box spanned the whole board area,
    // outside the column's scroll clip, and a drag paid for it on every frame
    // (board-drag-frames.spec.ts: ~360 -> ~290 ms of main thread per pass).
    const root = /className=\{`group ([^`]*?)\$\{isDragging/.exec(src);
    expect(root, 'the card root className moved: this test guards nothing').not.toBeNull();
    expect(root![1]!.split(/\s+/)).toContain('relative');
    expect(src).toContain('<SwapIce freeze={swapFreeze} size="card" />');
  });
});
