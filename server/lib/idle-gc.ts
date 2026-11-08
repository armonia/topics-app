/**
 * LA MEMORIA CHE IL SERVER HA PRESO E NON RIDÀ, restituita quando non serve.
 *
 * PERCHÉ ESISTE. Il 2026-08-19, con l'utente che segnalava «1,8 GB», il server
 * di produzione misurava: `phys_footprint` **936 MB**, picco storico **2,4 GB**
 * — e heap JS dichiarata **52 MB**, RSS **110 MB**. Gli 826 MB di differenza
 * erano pagine che il processo aveva toccato durante i turni degli agenti, che
 * il sistema aveva poi mandato in swap, e che nessuno ha mai restituito: swap
 * occupato, ma ancora contabilizzato all'app da `phys_footprint` — cioè dalla
 * colonna «Memoria» di Monitoraggio Attività, che è esattamente il numero che
 * l'utente legge sulla barra di stato e in Monitoraggio Attività.
 *
 * Quindi NON era un leak: nessuna struttura viva cresceva (la heap è piatta a
 * 52 MB su cinque ore di uptime). Era memoria trattenuta dall'allocatore dopo
 * i picchi, che è un difetto diverso e ha un rimedio diverso — non «trova chi
 * accumula», ma «di' all'allocatore di ridarla».
 *
 * CHE `Bun.gc(true)` LO FACCIA DAVVERO è misurato, non sperato, perché la
 * domanda che conta non era se libera la heap (quello è ovvio) ma se scioglie
 * anche le pagine GIÀ FINITE IN SWAP, che sono l'intero fenomeno qui:
 *
 *     allocati 960 MB   → footprint 968,8 MB   RSS 985 MB
 *     dopo 25s fermo    → footprint 969,0 MB   RSS  22 MB   ← swappato
 *     dopo Bun.gc(true) → footprint   8,7 MB   RSS  22 MB   ← restituito
 *
 * La riga di mezzo è la prova che serviva: il footprint NON scende da solo
 * quando il sistema swappa: scende solo quando qualcuno chiama il collettore.
 *
 * PERCHÉ SOLO A RIPOSO, e non a intervallo fisso. `Bun.gc(true)` è sincrono e
 * ferma l'event loop, e questo server è Bun con `bun:sqlite` SINCRONO: una
 * pausa qui è una pausa per tutti, e su HTTP/1.1 occupa una delle sei
 * connessioni che il browser concede (la stessa coda che `scripts/hol-probe.mjs`
 * ha misurato mandando una richiesta da 212 byte ad aspettare 19,3 secondi).
 * Pagarla mentre un agente lavora sarebbe scambiare memoria con la latenza
 * dell'unica cosa che l'utente sta guardando. A riposo non costa niente a
 * nessuno, e a riposo è anche il momento in cui c'è più da restituire, perché
 * il picco è appena passato.
 *
 * Il predicato di riposo è lo STESSO di `/__daemon/restart-when-idle`
 * (`describeInFlight`), non una seconda idea di «fermo»: se una fonte basta a
 * trattenere un riavvio, basta anche a trattenere una pausa dell'event loop.
 * Quel modulo esiste proprio perché una definizione più stretta di «fermo»
 * (solo `busyCount()`) aveva già ingannato un cancello — vedi il suo commento.
 *
 * E NON GIRA A VUOTO. Sotto una soglia di footprint non c'è niente da
 * recuperare e la pausa sarebbe gratis solo per modo di dire: il giro si salta
 * senza chiamare il collettore.
 */

import { describeInFlight, type QuiescenceSources } from "./quiescence";

/**
 * Ogni quanto ci si chiede se c'è da restituire.
 *
 * Due minuti, non cinque: il giro costa una lettura di `proc_pid_rusage` quando
 * non c'è niente da fare, e 1-15 ms quando c'è. Più fitto vuol dire che la
 * memoria di un picco torna al sistema mentre il picco è ancora recente,
 * invece di restare a marcire in swap per la maggior parte di un quarto d'ora.
 */
export const IDLE_GC_EVERY_MS = 2 * 60_000;

/**
 * Sotto questo footprint non si tocca niente.
 *
 * Un server appena partito con il DB caldo sta sui 150-250 MB, ed è il suo
 * costo di esercizio: chiamare il collettore lì dentro paga una pausa per
 * recuperare le briciole. La soglia sta sopra quella fascia e molto sotto i
 * 936 MB misurati, cioè accende solo quando c'è davvero qualcosa da rendere.
 */
export const IDLE_GC_SOGLIA_MB = 400;

/**
 * Quanto si aspetta prima di RILEGGERE il footprint.
 *
 * `Bun.gc(true)` torna prima che il sistema abbia ripreso le pagine: misurato,
 * subito dopo la chiamata il footprint è ancora **731 MB**, a +50 ms e a
 * +200 ms pure, e a **+1000 ms è 11 MB**. Il rilascio è asincrono.
 *
 * Senza questa attesa la lettura «dopo» è identica alla lettura «prima», e il
 * modulo riporta zero recuperati mentre ne ha appena resi settecento — cioè un
 * log che smentisce il proprio effetto, ed è il modo esatto in cui un rimedio
 * che funziona viene rimosso da chi legge i suoi numeri. La raccolta avveniva
 * comunque: era il RESOCONTO a essere falso.
 */
const ATTESA_RILASCIO_MS = 1500;

export interface IdleGcDeps {
  /**
   * Le tre fonti che sanno se qualcosa sta lavorando.
   *
   * Può tornare una promessa: nel server la stessa domanda la risponde
   * `whatIsStillWorking()`, che per la terza fonte (i turni adottati, visibili
   * solo al broker) fa una sonda vera. Riusarla invece di ricostruirne una
   * versione sincrona è ciò che tiene UNA sola definizione di «fermo».
   */
  sorgenti: () => QuiescenceSources | Promise<QuiescenceSources>;
  /** Il footprint del processo in MB, o null se non misurabile. */
  footprintMB: () => number | null;
  /** Il collettore vero e proprio (iniettato per poterlo contare nei test). */
  raccogli: () => void;
  /** Dove finisce la riga di esito. */
  log?: (msg: string) => void;
  /**
   * L'attesa fra la raccolta e la rilettura, iniettabile.
   *
   * Esiste per i test: senza, ogni caso che raccoglie paga 1,5 secondi veri e
   * una suite da nove casi impiega dieci secondi per stare ferma. Il valore di
   * produzione resta `ATTESA_RILASCIO_MS`, ed è quello misurato.
   */
  attesaMs?: number;
}

export type OutcomeIdleGc =
  | { azione: "saltato"; perche: string }
  | { azione: "raccolto"; primaMB: number; dopoMB: number | null };

/**
 * QUANDO IL FERMO NON ARRIVA MAI, e la prudenza diventa un difetto.
 *
 * Il predicato del riavvio è quello giusto per un RIAVVIO, che taglia i turni.
 * Applicato tale e quale qui si è rivelato troppo stretto: sulla macchina
 * dell'utente `activeStreams` ha due chat aperte quasi sempre — misurato, il
 * gc non sarebbe scattato una sola volta in dieci minuti — e un rimedio che non
 * parte mai è indistinguibile dal non averlo scritto.
 *
 * La prudenza si giustificava con «la pausa è di tutti». Misurata, la pausa è
 * **1-15 ms**, e su una heap di 18.845 oggetti vivi (la taglia di un server
 * anziano) il caso peggiore di sei giri è **8 ms**. Non secondi: meno di un
 * frame. Contro centinaia di megabyte che non tornano indietro in nessun altro
 * modo, quel prezzo si paga.
 *
 * Quindi restano fuori le CARD della board — lì un turno d'agente sta scrivendo
 * file e nessuno lo guarda, quindi la sua latenza è l'unica cosa che ha — e si
 * accetta di raccogliere mentre una chat streamma. Il conto è esplicito: 8 ms
 * su un token di uno stream sono invisibili; 800 MB che non tornano no.
 */
/**
 * Un giro. Restituisce cosa ha fatto e perché — così il test verifica la
 * DECISIONE senza dover osservare la memoria vera, che in un test non è
 * governabile.
 */
export async function giroIdleGc(deps: IdleGcDeps): Promise<OutcomeIdleGc> {
  const fonti = await deps.sorgenti();
  // Le sole due fonti che trattengono: una card che lavora, o un turno che vive
  // nel broker (che è una card adottata dopo un riavvio, non una chat).
  const inVolo = describeInFlight({ ...fonti, streamKeys: [] });
  if (inVolo) return { azione: "saltato", perche: inVolo };

  const prima = deps.footprintMB();
  if (prima === null) return { azione: "saltato", perche: "footprint non misurabile" };
  if (prima < IDLE_GC_SOGLIA_MB) {
    return { azione: "saltato", perche: `${prima} MB, sotto la soglia di ${IDLE_GC_SOGLIA_MB}` };
  }

  deps.raccogli();
  // Vedi ATTESA_RILASCIO_MS: leggere subito misura il footprint di prima.
  await new Promise((r) => setTimeout(r, deps.attesaMs ?? ATTESA_RILASCIO_MS));
  const dopo = deps.footprintMB();
  if (dopo !== null && deps.log) {
    const reso = prima - dopo;
    // Si stampa solo quando ha reso qualcosa di visibile: una riga ogni cinque
    // minuti che dice «0 MB» è rumore in un log che qualcuno dovrà leggere.
    if (reso >= 50) deps.log(`[idle-gc] restituiti ${reso} MB (${prima} → ${dopo})`);
  }
  return { azione: "raccolto", primaMB: prima, dopoMB: dopo };
}
