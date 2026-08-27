/**
 * IL DIVIDER SOPRAVVIVE ALLA RIGA CHE LO PORTAVA.
 *
 * Da quando `/compact` chiude davvero il suo turno (vedi
 * `providers/claude-code-compaction-result.test.ts`), quel turno finalizza una
 * riga assistente COMPLETAMENTE VUOTA: una compattazione non produce testo, il
 * suo esito è il divider «Contesto compattato», che vive in una tabella sua. La
 * riga vuota viene quindi scartata (`discardIfEmptyTurn` in `routes/chat.ts`),
 * o resterebbe una bolla vuota in chat e nella history rimandata al modello.
 *
 * Il rischio che questo file chiude: **il marker è ancorato a un messaggio**
 * (`after_message_id`), e cancellare messaggi è anche il mestiere di
 * `truncateSessionAfter`, che i marker orfani li BUTTA. Se lo scarto della riga
 * vuota si comportasse allo stesso modo, il rimedio a `/compact` cancellerebbe
 * proprio il divider che è l'unica prova visibile che la compattazione è
 * avvenuta — e avremmo scambiato un guasto rumoroso con uno silenzioso.
 *
 * Non lo fa, e il perché non è un dettaglio: le due cancellazioni rispondono a
 * due domande diverse. Un rollback a checkpoint cancella dei CONTENUTI, e un
 * divider che racconta la compattazione di roba sparita non ha più senso; lo
 * scarto di un segnaposto vuoto non cancella nessun contenuto (per definizione
 * non ce n'era), quindi il marker si RI-ANCORA al padre e resta nello stesso
 * punto del thread. Qui si misura che sia davvero così.
  * @covers COMPACT-DIV-01
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase } from "./db";
import { createAppContext } from "./utils";
import { insertCompactionMarkerIfNew, getCompactionMarkersBySession } from "./db/compaction-markers";
import type { AppContext, Topic } from "./types";

/* DATA_DIR E' AMBIENTE CONDIVISO, e questo file lo scrive.
 *
 * `server/db.ts:17` risolve la cartella dati come `process.env.DATA_DIR ||
 * join(dataRoot, "data")`: l'ambiente vince sull'argomento esplicito. Bun
 * carica piu' file di test nello STESSO processo, quindi una scrittura non
 * restituita decide dove finisce il database di tutti i file caricati dopo.
 * Misurato il 21/08: due file lanciati insieme aprivano quattro volte lo
 * stesso db temporaneo di uno dei due, mentre da soli ne creavano di propri.
 * Qui la variabile serve davvero (non si passa da `initDatabase`), quindi si
 * RESTITUISCE invece di toglierla. */
const DATA_DIR_PRIMA = process.env.DATA_DIR;


let tmpRoot: string;
let ctx: AppContext;

const SK = "topic:compactdiscard";

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "compact-discard-test-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (!f.endsWith(".sql")) continue;
    writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  mkdirSync(join(tmpRoot, "public"), { recursive: true });
  process.env.DATA_DIR = join(tmpRoot, "data");
  process.env.OPENCLAW_DIR = join(tmpRoot, "openclaw");
  ctx = createAppContext(tmpRoot);
  const now = new Date().toISOString();
  const topic: Topic = {
    id: "cmpdisc0-aaaa-bbbb-cccc-000000000001",
    name: "Compact discard",
    slug: "compact-discard",
    parentId: null,
    links: [],
    sessionKey: SK,
    color: "#aabbcc",
    icon: "chat",
    createdAt: now,
    updatedAt: now,
    archived: false,
  };
  ctx.saveSingleTopic(topic);
});

afterAll(() => {
  try { closeDatabase(); } catch {}
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("il turno di /compact non lascia una bolla vuota — né perde il divider", () => {
  test("la riga vuota si scarta e il marker si ri-ancora al messaggio precedente", () => {
    // La chat prima del comando: una domanda e la sua risposta.
    const domanda = ctx.appendLocalMessage(SK, "user", "una domanda qualsiasi");
    const risposta = ctx.appendLocalMessage(SK, "assistant", "una risposta qualsiasi");
    // Poi `/compact`, e il segnaposto assistente che il suo turno apre.
    ctx.appendLocalMessage(SK, "user", "/compact");
    const vuoto = ctx.createPartialMessage(SK, "assistant");

    // Il `compact_boundary` arriva DENTRO quel turno: il marker si ancora al
    // padre del segnaposto, che è esattamente ciò che fa `routes/chat.ts`.
    const marker = insertCompactionMarkerIfNew(ctx.db, {
      sessionKey: SK,
      afterMessageId: vuoto.parentId ?? null,
      marker: { trigger: "manual", preTokens: 574474 },
    });
    expect(marker.afterMessageId).toBeTruthy();

    // Il turno si chiude senza aver prodotto niente di mostrabile.
    const finalizzato = ctx.updateLastMessage(SK, { content: "", partial: undefined, streamedAt: undefined });
    const scartato = ctx.discardIfEmptyTurn(SK, finalizzato);

    // 1) La bolla vuota non resta in chat.
    expect(scartato).toBe(vuoto.id);
    expect(ctx.getMessageById(vuoto.id)).toBeFalsy();

    // 2) IL PUNTO: il divider è ancora lì. Cancellarlo insieme alla riga
    //    vorrebbe dire togliere l'unica prova visibile che la compattazione è
    //    avvenuta — cioè barattare un guasto rumoroso con uno muto.
    const rimasti = getCompactionMarkersBySession(ctx.db, SK);
    expect(rimasti.length).toBe(1);
    expect(rimasti[0].id).toBe(marker.id);
    expect(rimasti[0].preTokens).toBe(574474);

    // 3) …e sta ancora in un punto SENSATO del thread: ancorato a un messaggio
    //    che esiste, non appeso nel vuoto (dove `partitionMarkers` lo
    //    sbatterebbe in cima alla chat, che è la sua rete di sicurezza, non il
    //    posto giusto).
    const ancora = rimasti[0].afterMessageId;
    expect(ancora).toBeTruthy();
    expect(ctx.getMessageById(ancora!)).toBeTruthy();

    // La conversazione di prima è intatta: scartare un segnaposto vuoto non
    // tocca nessun contenuto.
    expect(ctx.getMessageById(domanda.id)).toBeTruthy();
    expect(ctx.getMessageById(risposta.id)).toBeTruthy();
  });

  test("un turno di compattazione che HA prodotto qualcosa non si scarta", () => {
    // Controprova: `discardIfEmptyTurn` cancella solo ciò che è davvero vuoto.
    // Se un giorno la CLI accompagnasse la compattazione con una riga di testo,
    // quella riga è lavoro fatto e resta — insieme al suo divider.
    ctx.appendLocalMessage(SK, "user", "/compact");
    const withText = ctx.createPartialMessage(SK, "assistant");
    ctx.appendToLastMessage(SK, "Ho compattato: ora il contesto sta in un terzo.");
    const finalizzato = ctx.updateLastMessage(SK, { partial: undefined, streamedAt: undefined });

    expect(ctx.discardIfEmptyTurn(SK, finalizzato)).toBeNull();
    expect(ctx.getMessageById(withText.id)).toBeTruthy();
  });
});

afterAll(() => {
  if (DATA_DIR_PRIMA === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = DATA_DIR_PRIMA;
});
