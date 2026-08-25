/**
 * La finestra dei commenti che viaggiano sulla card porta SEMPRE l'ultima cosa
 * che ho detto io.
 *
 * ── Il difetto, misurato sulla board vera (20/08) ──────────────────────────
 * `CARD_COMMENTS_DEPTH` è 3: sulla card arrivano gli ultimi tre commenti, più
 * l'ultima «parola vera» per quanto indietro sia. Regola sensata finché il
 * thread è corto — ma su una card viva le note della macchina si accumulano
 * DOPO l'ultima cosa che ha scritto una persona:
 *
 *     a41af39a → 26 righe fra il mio messaggio e la cima
 *     235afe11 → 17
 *     b673a253 → 16
 *
 * Su `a41af39a` il mio messaggio stava in posizione SETTE, quindi alla card non
 * arrivava mai. Non perché il client lo scartasse — il client non lo riceveva
 * affatto: nessun pixel poteva mostrarlo, e nessun fix lato client avrebbe
 * potuto ripararlo.
 *
 * Chiesto così: «da review dovrei SEMPRE vedere l'ultimo suo e mio messaggio».
 * Il «sempre» valeva solo per i thread corti.
 *
 * ── Perché il test gira la query VERA ──────────────────────────────────────
 * La finestra è SQL, e una sua parafrasi in TypeScript proverebbe la parafrasi.
 * Qui il testo della query si legge da `server/services/tasks.ts` e si esegue
 * su un database in memoria: se qualcuno cambia la query e non questo file, il
 * test se ne accorge invece di continuare a provare una copia.
  * @covers KANBAN-27
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./helpers";

const TASKS_TS = fs.readFileSync(path.join(PROJECT_ROOT, "server/services/tasks.ts"), "utf-8");

/**
 * I tre pezzi della finestra, estratti dal sorgente invece che ricopiati.
 *
 * `SQL_PAROLA` e `SQL_MIA` sono stringhe TypeScript concatenate; il `WHERE` è
 * dentro un template literal. Si prendono da lì: se cambiano, cambia il test.
 */
function estrai(nome: string): string {
  const m = TASKS_TS.match(new RegExp(`const ${nome} =\\s*([\\s\\S]*?);\\n`));
  if (!m) throw new Error(`${nome} non trovato in tasks.ts`);
  // Le righe sono `"…" +` concatenate: si tolgono virgolette e più.
  return m[1]!.split("\n").map((r) => r.trim().replace(/^"|"\s*\+?$|";?$/g, "").replace(/"\s*\+$/, "")).join(" ");
}

const SQL_PAROLA = estrai("SQL_PAROLA");
const SQL_MIA = estrai("SQL_MIA");

/** La `WHERE` della finestra, letta dal sorgente. */
const WHERE = (() => {
  const m = TASKS_TS.match(/\) WHERE rn <= \$\{CARD_COMMENTS_DEPTH\}([\s\S]*?)\n\s*ORDER BY task_id/);
  if (!m) throw new Error("la WHERE della finestra non e' piu' riconoscibile in tasks.ts");
  return `rn <= 3 ${m[1]!.replace(/\s+/g, " ").trim()}`;
})();

const QUERY = `
  SELECT author, content FROM (
    SELECT c.*,
      row_number() OVER (PARTITION BY c.task_id ORDER BY c.created_at DESC, c.rowid DESC) AS rn,
      row_number() OVER (PARTITION BY c.task_id, ${SQL_PAROLA} ORDER BY c.created_at DESC, c.rowid DESC) AS rn_parola,
      row_number() OVER (PARTITION BY c.task_id, ${SQL_MIA} ORDER BY c.created_at DESC, c.rowid DESC) AS rn_mia,
      ${SQL_MIA} AS mia,
      ${SQL_PAROLA} AS parola
    FROM task_comments c
    WHERE COALESCE(c.kind, 'comment') NOT IN ('status', 'service')
  ) WHERE ${WHERE}
  ORDER BY rn DESC`;

function dbConCommenti(righe: Array<[string, string, string]>): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT, author TEXT, content TEXT,
    kind TEXT DEFAULT 'comment', created_at TEXT)`);
  righe.forEach(([author, kind, content], i) => {
    db.run("INSERT INTO task_comments VALUES (?,?,?,?,?,?)",
      [String(i), 't1', author, content, kind, `2026-08-20T${String(10 + i).padStart(2, '0')}:00:00Z`]);
  });
  return db;
}

describe('la finestra dei commenti della card', () => {
  /**
   * IL CASO `a41af39a`: il mio messaggio sepolto sotto le note della macchina.
   * Con la sola regola `rn <= 3` non arriva; con `rn_mia = 1` sì.
   */
  test('il mio ultimo messaggio viaggia anche da sette posizioni indietro', () => {
    const db = dbConCommenti([
      ['user', 'comment', 'Verifica col land esteso'],          // il mio, in fondo
      ['agent:x', 'comment', 'Riconciliato il ramo'],
      ['system', 'comment', 'Il ramo era indietro di 26 commit'],
      ['agent:x', 'comment', 'Sbloccata la consegna'],
      ['system', 'comment', 'Checks pre-review ROSSI'],
      ['system', 'comment', "L'agent ha lavorato 4 turni"],
      ['verifier', 'review-note', 'Nessuna anteprima allegata'],
    ]);
    const out = db.query(QUERY).all() as Array<{ author: string; content: string }>;
    db.close();
    // C'E'. E' l'asserzione che il difetto rendeva impossibile.
    expect(out.some((r) => r.author === 'user')).toBe(true);
    expect(out.find((r) => r.author === 'user')?.content).toContain('land esteso');
  });

  /**
   * La finestra resta STRETTA: si aggiunge una riga, non si trasporta il
   * thread. Una card che porta tutto e' una board che scarica un database a
   * ogni lista.
   */
  test('non trascina tutto il thread: solo la coda piu' + "' l'essenziale", () => {
    const db = dbConCommenti([
      ['user', 'comment', 'il mio, vecchissimo'],
      ...Array.from({ length: 10 }, (_, i) =>
        ['system', 'comment', `nota ${i}`] as [string, string, string]),
    ]);
    const out = db.query(QUERY).all() as Array<{ author: string }>;
    db.close();
    // Tre di coda + il mio. Non undici.
    expect(out.length).toBeLessThanOrEqual(5);
    expect(out.some((r) => r.author === 'user')).toBe(true);
  });

  /**
   * Il server firma `user` anche la PROPRIA narrazione quando una leva l'ha
   * tirata una persona (Stop, archiviazione con agente vivo): quelle non sono
   * parole mie, e `SQL_MIA` le esclude con `kind = 'comment'`. Se le
   * trasportasse, la card mi restituirebbe come mia una frase che non ho
   * scritto — lo stesso difetto che `isHumanComment` evita sul client.
   */
  test('una narrazione del server firmata user non e' + "' un mio messaggio", () => {
    const db = dbConCommenti([
      ['user', 'review-note', 'Fermato da te: agent interrotto.'],
      ...Array.from({ length: 5 }, (_, i) =>
        ['system', 'comment', `nota ${i}`] as [string, string, string]),
    ]);
    const out = db.query(QUERY).all() as Array<{ author: string; kind?: string }>;
    db.close();
    // La review-note non viene ripescata come «il mio ultimo messaggio».
    expect(out.some((r) => r.author === 'user')).toBe(false);
  });
});

/**
 * LE DUE SPONDE DEVONO DIRE LA STESSA COSA sul testo che viaggia.
 *
 * Il server taglia il contesto a `CARD_CONTEXT_CHARS`; il client lo ripiega e
 * offre «mostra di piu'» oltre `RICHIESTA_PIEGA_CHARS`, promettendo nella sua
 * doc che «il testo c'e' tutto, basta un click». Se il server ne manda MENO di
 * quanti il client ne rende prima di offrire il bottone, quel bottone apre sul
 * vuoto.
 *
 * QUALE COSTANTE, e perche' e' facile sbagliarla: il client ne ha DUE.
 * `COMMENTO_PIEGA_CHARS` (620) governa la parola principale, quella che la card
 * stampa in cima; `RICHIESTA_PIEGA_CHARS` (190) governa la riga di CONTESTO,
 * che e' dove finisce il mio messaggio quando l'agente ha risposto dopo di me.
 * La prima stesura di questo test confrontava la prima delle due — passava, ma
 * sorvegliava il contratto sbagliato.
 *
 * Il difetto vero e' misurato: 1.215 messaggi umani su questa macchina, mediana
 * 520, il 76% sopra i 200 che il server mandava. 620 e' il massimo che sta nel
 * cancello sul peso del payload (800 lo sfonda), e copre entrambe le soglie del
 * client con margine.
 */
describe("il testo del contesto: server e client d'accordo", () => {
  const leggi = (file: string, re: RegExp): number => {
    const src = fs.readFileSync(path.join(PROJECT_ROOT, file), 'utf-8');
    const n = Number(src.match(re)?.[1] ?? '0');
    expect(n).toBeGreaterThan(0);
    return n;
  };

  test('il server ne manda almeno quanti il client ne rende prima di piegare', () => {
    const server = leggi('server/services/tasks.ts', /const CARD_CONTEXT_CHARS = (\d+);/);
    // LA SOGLIA DELLA RIGA DI CONTESTO, che e' quella che governa il mio
    // messaggio quando compare sotto la risposta dell'agente.
    const contesto = leggi('client/src/components/Board/constants.ts', /RICHIESTA_PIEGA_CHARS = (\d+);/);
    expect(server).toBeGreaterThanOrEqual(contesto);
  });

  test('e copre anche la soglia della parola principale', () => {
    const server = leggi('server/services/tasks.ts', /const CARD_CONTEXT_CHARS = (\d+);/);
    // Un commento che oggi e' contesto domani puo' essere la parola in cima
    // (basta che l'agente non risponda piu'): se il taglio del server stesse
    // sotto anche a questa, il pieghevole aprirebbe sul vuoto in quel caso.
    const principale = leggi('client/src/components/Board/constants.ts', /COMMENTO_PIEGA_CHARS = (\d+);/);
    expect(server).toBeGreaterThanOrEqual(principale);
  });
});
