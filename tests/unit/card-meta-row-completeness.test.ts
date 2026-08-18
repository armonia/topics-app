/**
 * OGNI CHIP DELLA CARD DEVE ESSERE NELL'ELENCO CHE MONTA LA SUA RIGA.
 *
 * `Card.tsx` disegna i chip dentro `{hasMetaRow && (...)}`, e `hasMetaRow` è un
 * OR scritto a mano dei chip possibili. Chi ne aggiunge uno e non lo scrive lì
 * ottiene un chip che non si monta mai — con il dato giusto nel DB, giusto
 * nella rotta, giusto in mano al client.
 *
 * Non è teorico: è successo il 16/08 con `card-delivery-stat` ed è costato tre
 * giri di debug. Ogni misura diceva che tutto funzionava (il DB aveva 7, il
 * feed HTTP aveva 7, `page.evaluate` nel browser aveva 7, la condizione
 * compilata nel bundle era corretta) mentre a schermo non c'era niente, perché
 * il contenitore non esisteva.
 *
 * Il test legge il SORGENTE: è l'unico posto in cui la domanda «esistono chip
 * fuori dall'elenco?» ha una risposta, dato che un chip mancante non produce
 * DOM da interrogare.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SORGENTE = readFileSync(
  resolve(import.meta.dir, "../../client/src/components/Board/Card.tsx"), "utf8",
);

/** La riga che decide se la fascia dei chip si monta. */
function condizioneRiga(): string {
  const riga = SORGENTE.split("\n").find((l) => l.includes("const hasMetaRow ="));
  if (!riga) throw new Error("hasMetaRow non trovato: il contenitore dei chip è cambiato nome");
  return riga;
}

/** I `data-testid` dei chip disegnati DENTRO la fascia. */
function chipDentroLaFascia(): string[] {
  const inizio = SORGENTE.indexOf("{hasMetaRow && (");
  expect(inizio, "la fascia dei chip deve esistere").toBeGreaterThan(0);
  // Fino alla fine del componente: i chip stanno tutti lì dentro, e prendere
  // qualche testid di troppo renderebbe il test più severo, non più debole.
  // FINO ALLA CHIUSURA DELLA FASCIA, non fino alla fine del componente. Dopo
  // la fascia ci sono altri chip (l'errore d'azione, per dirne uno) che non
  // c'entrano con `hasMetaRow`: prenderli renderebbe il test severo nel posto
  // sbagliato, cioe' rumoroso, cioe' da spegnere.
  const dopo = SORGENTE.slice(inizio);
  const fine = dopo.indexOf("\n      )}");
  const corpo = fine > 0 ? dopo.slice(0, fine) : dopo;
  return [...corpo.matchAll(/data-testid="(card-[a-z-]+)"/g)].map((m) => m[1]!);
}

/**
 * Il chip è disegnato dentro un `{predicato && (`?
 *
 * Si guarda all'INDIETRO dal suo `data-testid` fino al `{... && (` più vicino:
 * se fra i due non c'è la chiusura di un altro blocco, quel chip è
 * condizionato, e allora la sua condizione deve stare in `hasMetaRow`. Un chip
 * incondizionato (sempre disegnato) non ha questo problema.
 */
function chipCondizionato(testid: string): boolean {
  const i = SORGENTE.indexOf(`data-testid="${testid}"`);
  if (i < 0) return false;
  // Una finestra corta: la condizione di un chip sta nelle righe subito sopra.
  const prima = SORGENTE.slice(Math.max(0, i - 400), i);
  const apre = prima.lastIndexOf("&& (");
  if (apre < 0) return false;
  // Fra il `&& (` e il chip non deve esserci la fine di un altro blocco JSX,
  // altrimenti quel `&&` governa qualcos'altro.
  return !prima.slice(apre).includes(")}");
}

describe("la fascia dei chip conosce tutti i suoi chip", () => {
  it("ogni chip condizionato compare nell'elenco di hasMetaRow", () => {
    const condizione = condizioneRiga();
    const trovati = chipDentroLaFascia();
    expect(trovati.length, "nessun chip trovato: il selettore è andato a vuoto").toBeGreaterThan(1);

    // La mappa da `data-testid` al nome della variabile che lo governa. Sta qui
    // e non è dedotta: dedurla dal sorgente vorrebbe dire riscrivere JSX, e un
    // parser approssimativo darebbe verdi falsi proprio nel caso che conta.
    const governatoDa: Record<string, string> = {
      "card-delivery-stat": "deliveryStat",
      // Un ramo senza un solo commit (18/08): non e' una consegna piccola, e'
      // nessuna consegna, e il land si rifiutera'. Va detto dalla colonna.
      "card-uncommitted": "senzaCommit",
      "card-not-landed": "notLanded",
      "card-conductor-closes": "conductorCloses",
      "card-review-age": "attesa",
      "card-checks-green": "checksGreen",
      "card-checks-running": "checksRunning",
      "card-checks-red": "checksRed",
      // Il terzo esito dei checks (18/08): uno SCADUTO non e' un rosso, e il chip
      // ambra lo dice. Predicato suo, disgiunto da `checksRed`.
      "card-checks-unknown": "checksUnknown",
      "card-system-delivered": "systemDelivered",
      "card-blocked-by": "blockedChip",
      "card-reopened": "reopened",
      "card-waiting-on-this": "waitingOnThis",
      "card-worked-in-place": "lavoroInPlace",
      "card-moved-by-hand": "spostataAMano",
      "card-nothing-delivered": "senzaConsegna",
      // Questo ha DUE condizioni in `&&`: basta che una delle due sia nella
      // riga, ed e' `showsQuestion` a portarcelo (via `attesa`/`assignedTo`).
      "card-human-context": "humanContextText",
    };

    const mancanti = trovati
      .filter((t) => governatoDa[t])
      .filter((t) => !condizione.includes(governatoDa[t]!));

    expect(mancanti,
      `chip che non montano mai perché fuori da hasMetaRow: ${mancanti.join(", ")}`,
    ).toEqual([]);

    // IL BUCO DELLA MAPPA SCRITTA A MANO, chiuso qui.
    //
    // `governatoDa` è compilata a mano, quindi un chip NUOVO non è coperto
    // finché qualcuno non lo aggiunge: esattamente la stessa dimenticanza che
    // questo test esiste per prendere, un piano più su. Verificato il 17/08
    // sabotando `card-moved-by-hand` (tolto da `hasMetaRow`): questo test
    // restava verde mentre la e2e diventava rossa.
    //
    // Il chip che sta dentro un `{qualcosa && (` deve avere una riga qui.
    const scoperti = trovati.filter((t) => !governatoDa[t] && chipCondizionato(t));
    expect(scoperti,
      `chip condizionati senza una riga in governatoDa: ${scoperti.join(", ")}. ` +
      `Aggiungila, altrimenti nessuno verifica che montino davvero.`,
    ).toEqual([]);
  });

  it("il chip della consegna ha UN solo predicato, non due copie", () => {
    // Due copie della stessa condizione (una nella riga, una sul chip) sono il
    // modo esatto in cui la riga smette di montarsi mentre il chip crede di
    // esserci. Il predicato si dichiara una volta e si usa in entrambi i punti.
    // Il predicato e' cambiato il 18/08 da `!= null` a `truthy`: uno ZERO non
    // deve piu' produrre il chip «0 file +0 -0», perche' quel caso ha il suo
    // (`card-uncommitted`) e dirlo due volte con la forma di una misura buona e'
    // il difetto. Cio' che il cancello sorveglia non cambia: UNA dichiarazione.
    const occorrenze = SORGENTE.split("const deliveryStat = task.status === 'review' && task.deliveryFilesChanged").length - 1;
    expect(occorrenze,
      "la condizione del chip va dichiarata una volta sola (const deliveryStat)",
    ).toBe(1);
    expect(SORGENTE.includes("deliveryFilesChanged != null"),
      "lo ZERO non deve tornare a valere come misura: quel caso e' `senzaCommit`",
    ).toBe(false);
  });
});
