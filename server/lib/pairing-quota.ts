/**
 * Quante richieste di appaiamento possono stare in coda, e cosa si fa quando
 * sono troppe.
 *
 * ── PERCHÉ IL TETTO DI PRIMA ERA UN'ARMA ────────────────────────────────────
 * C'erano due limiti: tre richieste per indirizzo, venti in tutto. Il primo è
 * giusto. Il secondo era GLOBALE e si applicava RIFIUTANDO chi arrivava: quindi
 * sette indirizzi che ne tenevano tre a testa saturavano la coda, e da quel
 * momento nessuno — nemmeno il proprietario col telefono in mano — riusciva più
 * ad appaiarsi, a finestre di tre minuti per volta.
 *
 * Sulla rete di casa era innocuo: chi può bussare è chi è già dentro casa tua.
 * Esposto su Internet diventa un dispetto che funziona: non fa entrare nessuno,
 * ma impedisce a TE di far entrare qualcuno. Ed è il modo peggiore in cui un
 * limite può rompersi, perché somiglia a un guasto.
 *
 * ── LA FORMA GIUSTA: SI SFRATTA, NON SI RIFIUTA ─────────────────────────────
 * Il tetto complessivo resta — la coda vive in memoria e non può crescere senza
 * fine — ma quando è pieno non si respinge chi arriva: si SFRATTA la richiesta
 * più vecchia dell'indirizzo che ne ha di più. Chi sta inondando perde i propri
 * posti prima di poter togliere il posto a qualcun altro, e chi bussa una volta
 * sola entra sempre.
 *
 * ── THE PER-ADDRESS CAP EVICTS TOO ──────────────────────────────────────────
 * This used to say the opposite: the per-address cap "stays a refusal, it is a
 * limit on YOU, and evicting your own requests to admit other requests of
 * yours would mean nothing". That holds while addresses are plentiful, which
 * is the home network, where every phone has one of its own.
 *
 * Behind the relay it is false, and that is what broke the product: every
 * request carries the PUBLIC address of the household's uplink. Phone, laptop
 * and everyone else on that line are ONE address. Three requests total, and
 * the fourth gets a 429.
 *
 * Those three do not even buy three devices: the pairing screen opens one
 * request per mount, so two reloads burn the cap. Measured through the live
 * relay on 2026-08-21: first POST 200, every one after it 429, with the phone
 * left showing "I can't reach Topics" in front of a computer that was up.
 *
 * So this cap evicts as well, and it evicts YOUR oldest. That is the right
 * victim: the old request belongs to a tab you already closed or reloaded, and
 * nobody is reading its code. The one in your hand is the newest. The cap
 * still does its job (no address accumulates more than MAX_PENDING_PER_IP live
 * requests) but stops being a way to lock yourself out.
 *
 * A refusal survives only where there is nothing to evict, which cannot
 * happen: to be at the cap you must hold at least one live request, and that
 * one is the candidate.
 */

export interface PendingLike {
  id: string;
  ip: string | null;
  createdAt: number;
}

/** Quante ne può tenere aperte UNO stesso indirizzo. Basso di proposito: chi
 *  appaia un telefono ne apre una. */
export const MAX_PENDING_PER_IP = 3;

/**
 * Il tetto della coda. Alto rispetto a prima (era 20) perché non è più un modo
 * per dire no: è solo il limite oltre il quale la memoria non deve crescere.
 * Chi arriva quando è piena entra comunque — a uscire è il più ingombrante.
 */
export const MAX_PENDING_TOTAL = 200;

export type OutcomeQuota =
  /** Si accetta. `sfratta` è l'id da togliere per far posto, se serve. */
  | { ok: true; sfratta: string | null }
  /**
   * Refused. Only reachable by an address at its cap holding nothing to evict,
   * which cannot happen: being at the cap means holding a live request, and
   * that one is the candidate. The branch stays because the type must not lie
   * about what this function can answer.
   */
  | { ok: false; motivo: "troppe da questo indirizzo" };

/**
 * Si può accettare una richiesta da `ip`, data la coda `pending`?
 *
 * Pura: prende la coda e restituisce una decisione. Chi chiama applica.
 */
export function valutaQuota(
  pending: readonly PendingLike[],
  ip: string | null,
): OutcomeQuota {
  // Il limite su chi chiede. Un indirizzo assente (non lo sappiamo) NON viene
  // raggruppato con gli altri sconosciuti: sommarli darebbe a un ignoto la
  // capacità di consumare la quota di un altro ignoto.
  //
  // At the cap we EVICT our own oldest instead of refusing. Behind the relay
  // "this address" is the household uplink, not a device: refusing here locks
  // out the OWNER's fourth attempt, which is the defect this branch was
  // rewritten for.
  if (ip) {
    const suoi = pending.filter((p) => p.ip === ip);
    if (suoi.length >= MAX_PENDING_PER_IP) {
      // The oldest is the tab already closed or reloaded: nobody is reading
      // its code any more. The one in your hand is the newest.
      const vittima = suoi.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
      return { ok: true, sfratta: vittima.id };
    }
  }

  if (pending.length < MAX_PENDING_TOTAL) return { ok: true, sfratta: null };

  // Coda piena: si fa posto togliendo alla riga più lunga. `null` solo se la
  // coda è vuota, che qui non può accadere.
  return { ok: true, sfratta: sceltoPerSfratto(pending) };
}

/** La chiave con cui si raggruppa chi non ha un indirizzo noto. Le parentesi
 *  bastano a renderla impossibile per un IP vero — e si VEDONO, a differenza del
 *  byte NUL che ci avevo messo prima: invisibile nel sorgente, introvabile con
 *  `grep`, e beccato solo dal guardiano che questo repo ha apposta. */
const UNKNOWN_KEY = "(ignoto)";

/**
 * Chi esce quando la coda è piena.
 *
 * L'indirizzo con più richieste in attesa, e di quello la più vecchia. Così chi
 * inonda paga per primo, e la richiesta di chi ha bussato una volta sola è
 * l'ULTIMA a essere toccata.
 *
 * A parità di numero si prende la più vecchia in assoluto: è anche quella più
 * vicina a scadere da sola, quindi la si anticipa di poco.
 */
export function sceltoPerSfratto(pending: readonly PendingLike[]): string | null {
  if (pending.length === 0) return null;

  const perIp = new Map<string, PendingLike[]>();
  for (const p of pending) {
    const k = p.ip ?? UNKNOWN_KEY;
    const l = perIp.get(k) ?? [];
    l.push(p);
    perIp.set(k, l);
  }

  let peggiore: PendingLike[] | null = null;
  for (const gruppo of perIp.values()) {
    if (!peggiore || gruppo.length > peggiore.length) { peggiore = gruppo; continue; }
    if (gruppo.length === peggiore.length) {
      const piuVecchiaQui = Math.min(...gruppo.map((p) => p.createdAt));
      const piuVecchiaLa = Math.min(...peggiore.map((p) => p.createdAt));
      if (piuVecchiaQui < piuVecchiaLa) peggiore = gruppo;
    }
  }
  if (!peggiore) return null;

  return peggiore.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b)).id;
}
