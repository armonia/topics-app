/**
 * Pure derivation for "how long since this session last updated, and is that long
 * enough to read as stale?". Feeds the sidebar's `labeled` streaming indicator so a
 * session that hasn't produced an update in 18 minutes no longer looks identical to
 * one that just did.
 *
 * The signal is TIME SINCE THE LAST UPDATE (sessionLastActivity), not time since the
 * phase started: a turn actively streaming keeps bumping its last-activity, so it
 * never reads as stale; only a turn that's gone quiet — e.g. parked waiting on a
 * background run whose Stop hook never fired — does. The sidebar spinner is binary,
 * so today the user can't tell "still updating" from "wedged". Showing "agg. Xm fa"
 * and, past a threshold, a calmer "no updates in a while" treatment makes that
 * legible — no server change (the actual phantom-phase healing is server-side and
 * out of scope here).
 *
 * Pure + deterministic on (lastUpdate, now) so the thresholds are unit-tested.
 */

/** Below this the spinner stays bare — a just-updated turn needs no readout. */
export const WORK_ELAPSED_AFTER_MS = 60_000; // 1 min since last update
/** No update for this long → the indicator reads as "in attesa / forse ferma". */
export const WORK_STALE_AFTER_MS = 600_000; // 10 min since last update

export interface WorkLongevity {
  /** now - lastUpdate, clamped to ≥ 0. 0 when `lastUpdate` is missing/invalid. */
  elapsedMs: number;
  /** Render the "agg. Xm fa" readout next to the glyph. */
  showElapsed: boolean;
  /** Escalate to the calm "no recent updates / possibly waiting" treatment. */
  isStale: boolean;
}

/**
 * @param lastUpdate epoch-ms the session last did something (sessionLastActivity)
 * @param now        epoch-ms "now" (a shared 1-per-app tick, not per-row)
 */
export function deriveWorkLongevity(lastUpdate: number | undefined, now: number): WorkLongevity {
  // No trustworthy last-update → no readout, no escalation. A future timestamp
  // (clock skew) clamps to 0 rather than showing a negative/absurd duration.
  if (typeof lastUpdate !== 'number' || !Number.isFinite(lastUpdate) || lastUpdate <= 0) {
    return { elapsedMs: 0, showElapsed: false, isStale: false };
  }
  const elapsedMs = Math.max(0, now - lastUpdate);
  return {
    elapsedMs,
    showElapsed: elapsedMs >= WORK_ELAPSED_AFTER_MS,
    isStale: elapsedMs >= WORK_STALE_AFTER_MS,
  };
}

/**
 * Minute-granularity duration for the sidebar chip: "2m", "18m", "1h 02m". No
 * seconds on purpose — the readout only appears past WORK_ELAPSED_AFTER_MS and a
 * seconds-ticking label in the sidebar reads as noise (and would force a 1s tick).
 */
export function formatElapsedCompact(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalM = Math.floor(ms / 60_000);
  if (totalM < 60) return `${Math.max(1, totalM)}m`;
  const h = Math.floor(totalM / 60);
  return `${h}h ${String(totalM % 60).padStart(2, '0')}m`;
}

// ─── Quale tempo mostrare accanto allo stato ──────────────────────────────────
//
// Sidebar e tab mostravano tempi diversi, calcolati in posti diversi, e a volte
// DUE nello stesso punto: una riga che stava lavorando diceva «Esegue un comando
// · 12s» nel sottotitolo (durata dell'ULTIMO tool) e «3m» accanto allo spinner
// (tempo dall'ultimo aggiornamento). Due numeri che rispondono a due domande che
// nessuno ha fatto, e nessuno dei due era quello che serve.
//
// La regola, una sola per ogni superficie:
//   · sta lavorando  → da quanto va avanti IL TURNO  (kind 'working')
//   · ha finito      → quanto fa che ha finito       (kind 'done')
// Una sola voce alla volta, accanto alla descrizione dello stato.

export type SubjectTimeKind = 'working' | 'done';

export interface SubjectTime {
  kind: SubjectTimeKind;
  /** Durata in ms, mai negativa. */
  ms: number;
  /** `true` quando il turno è in corso ma l'inizio non è noto (server riavviato
   *  a metà turno): la durata parte dall'ultima transizione di fase, quindi è un
   *  MINIMO. Chi mostra il numero lo dice nel tooltip invece di spacciarlo per
   *  esatto. */
  approx: boolean;
}

/** La parte di `SessionActivitySignal` che serve qui — niente import circolare. */
export interface SubjectTimeInput {
  working: boolean;
  since: number;
  turnSince?: number;
}

/**
 * @param activity       il descrittore vivo della sessione, se ce n'è uno
 * @param lastActivityAt epoch-ms dell'ultimo movimento (deriveSessionLastActivity):
 *                       l'unica base per una sessione FINITA, che un descrittore
 *                       vivo non ce l'ha più
 * @param now            epoch-ms condiviso (useSharedNow), non Date.now() per riga
 */
export function deriveSubjectTime(
  activity: SubjectTimeInput | undefined,
  lastActivityAt: number | undefined,
  now: number,
): SubjectTime | null {
  const valid = (t: number | undefined): t is number =>
    typeof t === 'number' && Number.isFinite(t) && t > 0;

  if (activity?.working) {
    // `turnSince` è la risposta giusta; `since` (inizio dell'ultimo tool) è il
    // ripiego quando il server è ripartito a metà turno e l'ha persa. In quel
    // caso il numero è un minimo, non la verità: `approx` lo dichiara.
    if (valid(activity.turnSince)) return { kind: 'working', ms: Math.max(0, now - activity.turnSince), approx: false };
    if (valid(activity.since)) return { kind: 'working', ms: Math.max(0, now - activity.since), approx: true };
    return null;
  }
  // Ferma: quanto fa che ha finito. Con un descrittore vivo (parcheggiata in
  // awaiting-*) `since` È il momento in cui è entrata in quella fase, cioè la
  // fine del turno. Senza descrittore (completed/dormant) resta l'ultimo
  // movimento noto.
  const at = activity && valid(activity.since) ? activity.since : lastActivityAt;
  if (!valid(at)) return null;
  return { kind: 'done', ms: Math.max(0, now - at), approx: false };
}

/**
 * Durata col SECONDO quando conta e senza quando è rumore: "8s", "45s", "12m",
 * "1h 02m". Sotto il minuto i secondi sono l'informazione (un turno appena
 * partito), sopra no — e `formatElapsedCompact`, che parte da "1m", li perdeva
 * tutti mostrando "1m" a un turno di tre secondi.
 */
export function formatElapsedShort(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return formatElapsedCompact(ms);
}
