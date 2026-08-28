/**
 * Il tetto di agenti in parallelo, UNO per macchina, in un posto solo.
 *
 * IL GUASTO CHE QUESTO MODULO CHIUDE. Il tetto si poteva vedere e cambiare solo
 * dal menu ▾ accanto al titolo della board. Il pannello delle impostazioni della
 * board non lo mostrava: lo nominava in un `title`, cioè in un tooltip, che su un
 * telefono non esiste. Chi apriva le impostazioni non vedeva nessun limite e
 * concludeva che non ce ne fosse.
 *
 * PERCHÉ UNO STORE DI MODULO E NON UNO STATO IN UN COMPONENTE. Adesso il
 * controllo compare in due superfici (il menu del titolo e il pannello), più il
 * chip del carico che legge la stessa sonda. Con una `useState` per superficie
 * sarebbero tre copie dello stesso numero, e la prima cosa che sarebbe successa
 * è quella già successa a `board:global-cap`: una finestra che cambia il tetto e
 * l'altra che resta sul valore vecchio. Qui il valore è uno: chi scrive scrive
 * lì, chi legge legge lì, e il broadcast del server ci entra dallo stesso punto.
 *
 * TRE SORGENTI, UNA PORTA:
 *   · `GET /api/all-boards/settings` al primo abbonato (il valore scritto);
 *   · `GET /api/system/dispatch-capacity` ogni 15s (la macchina viva: quanti
 *     agenti reggerebbe e quanti ne stanno girando ADESSO);
 *   · il frame WS `board:global-cap`, che il server manda a TUTTE le finestre
 *     quando qualcuno tocca il tetto da qualunque parte.
 *
 * La sonda gira finché c'è almeno un abbonato e si ferma con l'ultimo: prima ne
 * girava una per ogni chip del carico montato.
 */
import { useSyncExternalStore } from 'react';
import { boardApi, clampGlobalCap, effectiveDispatchCap } from '../lib/board';
import type { DispatchCapacity, GlobalDispatchCap } from '../lib/board';
import { subscribeFrames } from '../lib/wsFrameBus';

export interface GlobalDispatchCapState {
  /** Il tetto scritto. `null` = non ancora letto dal server. */
  cap: GlobalDispatchCap | null;
  /** La macchina viva. `null` = sonda non ancora risposta (o non disponibile). */
  capacity: DispatchCapacity | null;
  /** Una scrittura è in volo: l'interruttore non va ribaltato due volte. */
  saving: boolean;
  /**
   * THE SPEND and THE SPEND CAPS, from the same '*' row and therefore from the
   * same store: the spend in dollars is ALWAYS read, the caps are zero until a
   * person writes them, and zero means unlimited. `null` = not read yet, which is
   * not "no cap".
   */
  spend: SpendState | null;
}

/** What the server says about the spend: the two caps and the two ledger cuts. */
export interface SpendState {
  /** Per-card cap, in cents. 0 = unlimited (no brake). */
  capTaskCents: number;
  /** Per-machine cap over a rolling 24h window, in cents. 0 = unlimited. */
  capDayCents: number;
  cents24h: number;
  centsTotal: number;
  /** Equivalent consumption that cannot be priced (no price list), in tokens. */
  unpriced24h: number;
  unpricedTotal: number;
}

/** Ogni quanto si rilegge la macchina. Era il periodo del chip del carico, che
 *  ora legge di qui invece di sondare per conto suo. */
const CAPACITY_POLL_MS = 15000;

const EMPTY: GlobalDispatchCapState = { cap: null, capacity: null, saving: false, spend: null };

/** L'IDENTITÀ conta: `useSyncExternalStore` richiama lo snapshot a ogni render e
 *  un oggetto nuovo ogni volta è un ciclo infinito. Si sostituisce solo quando
 *  qualcosa cambia davvero. */
let state: GlobalDispatchCapState = EMPTY;

type Listener = () => void;
const listeners = new Set<Listener>();

function publish(next: GlobalDispatchCapState): void {
  state = next;
  listeners.forEach((cb) => {
    try { cb(); } catch { /* un lettore che esplode non deve affamare gli altri */ }
  });
}

export function getGlobalDispatchCapState(): GlobalDispatchCapState {
  return state;
}

/**
 * Il tetto AUTOREVOLE: la risposta del server o il frame che annuncia il cambio
 * fatto da un'altra finestra. Accetta la forma del filo (`maxAgentsAuto` /
 * `maxAgents`), che è la stessa del PATCH e del broadcast.
 */
export function adoptGlobalCap(next: { maxAgentsAuto?: boolean; maxAgents?: number }): void {
  const auto = typeof next.maxAgentsAuto === 'boolean' ? next.maxAgentsAuto : state.cap?.auto ?? true;
  const max = typeof next.maxAgents === 'number' ? clampGlobalCap(next.maxAgents) : state.cap?.max ?? 3;
  if (state.cap && state.cap.auto === auto && state.cap.max === max) return;
  publish({ ...state, cap: { auto, max } });
}

/**
 * The AUTHORITATIVE spend: the server's answer, or the frame from another window
 * that changed a cap (that one carries only the caps, not the totals, so the
 * totals stay as they were instead of dropping to zero).
 */
export function adoptSpend(next: {
  agentCostCapCents?: number;
  agentCostCapCents24h?: number;
  agentSpendCents24h?: number;
  agentSpendCentsTotal?: number;
  agentUnpricedCostTokens24h?: number;
  agentUnpricedCostTokensTotal?: number;
}): void {
  const prev = state.spend;
  const num = (v: number | undefined, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : (v === 0 ? 0 : fallback);
  const spend: SpendState = {
    capTaskCents: num(next.agentCostCapCents, prev?.capTaskCents ?? 0),
    capDayCents: num(next.agentCostCapCents24h, prev?.capDayCents ?? 0),
    cents24h: num(next.agentSpendCents24h, prev?.cents24h ?? 0),
    centsTotal: num(next.agentSpendCentsTotal, prev?.centsTotal ?? 0),
    unpriced24h: num(next.agentUnpricedCostTokens24h, prev?.unpriced24h ?? 0),
    unpricedTotal: num(next.agentUnpricedCostTokensTotal, prev?.unpricedTotal ?? 0),
  };
  if (
    prev && prev.capTaskCents === spend.capTaskCents && prev.capDayCents === spend.capDayCents &&
    prev.cents24h === spend.cents24h && prev.centsTotal === spend.centsTotal &&
    prev.unpriced24h === spend.unpriced24h && prev.unpricedTotal === spend.unpricedTotal
  ) return;
  publish({ ...state, spend });
}

/**
 * Writing a spend cap. Optimistic and then authoritative, like `saveGlobalCap`.
 * Zero clears the cap, and the client never proposes a value: a pre-filled cap is
 * a cap nobody chose.
 */
export async function saveSpendCaps(patch: { perTaskCents?: number; perDayCents?: number }): Promise<void> {
  const before = state.spend;
  if (before) {
    publish({
      ...state,
      saving: true,
      spend: {
        ...before,
        capTaskCents: patch.perTaskCents !== undefined ? Math.max(0, Math.trunc(patch.perTaskCents)) : before.capTaskCents,
        capDayCents: patch.perDayCents !== undefined ? Math.max(0, Math.trunc(patch.perDayCents)) : before.capDayCents,
      },
    });
  }
  try {
    const g = await boardApi.setSpendCaps(patch);
    publish({ ...state, saving: false });
    adoptSpend(g);
  } catch {
    publish({ ...state, spend: before, saving: false });
  }
}

/** L'ultima lettura della macchina (sonda o test). */
export function adoptDispatchCapacity(capacity: DispatchCapacity): void {
  publish({ ...state, capacity });
}

/**
 * Il numero che vale ADESSO, quello che una persona legge come «di quanti».
 * `null` finché non c'è abbastanza per dirlo senza inventare: in `auto` senza
 * sonda il tetto è quello che deciderà la macchina, non il numero fisso di
 * ripiego, e mostrare quest'ultimo sarebbe una bugia comoda.
 */
export function currentCapLimit(s: GlobalDispatchCapState): number | null {
  if (!s.cap) return null;
  if (s.cap.auto && !s.capacity) return null;
  return effectiveDispatchCap(s.cap, s.capacity?.recommended ?? null);
}

/**
 * Cambiare il tetto. È l'UNICO scrittore del client: le due superfici chiamano
 * questa, nessuna parla da sé con `boardApi.setGlobalCap`.
 *
 * Ottimistica e poi autorevole: il segno di spunta si muove sotto il dito, e la
 * risposta del server (che stringe il numero nei suoi estremi) sovrascrive.
 * Se la chiamata fallisce si torna al valore di prima, non si resta su una
 * bugia locale.
 */
export async function saveGlobalCap(patch: { auto?: boolean; max?: number }): Promise<void> {
  const before = state.cap;
  const next: GlobalDispatchCap = {
    auto: patch.auto ?? before?.auto ?? true,
    max: patch.max !== undefined ? clampGlobalCap(patch.max) : before?.max ?? 3,
  };
  publish({ ...state, cap: next, saving: true });
  try {
    const g = await boardApi.setGlobalCap(patch);
    publish({ ...state, cap: { auto: g.maxAgentsAuto, max: clampGlobalCap(g.maxAgents) }, saving: false });
  } catch {
    publish({ ...state, cap: before, saving: false });
  }
}

/** Rilegge il tetto scritto. Volontariamente muta sull'errore: il valore che c'è
 *  resta, e il prossimo giro riprova. */
async function refreshCap(): Promise<void> {
  try {
    const g = await boardApi.getGlobalSettings();
    adoptGlobalCap(g);
    adoptSpend(g);
  } catch { /* si tiene l'ultimo */ }
}

async function refreshCapacity(): Promise<void> {
  try {
    adoptDispatchCapacity(await boardApi.dispatchCapacity());
  } catch { /* la sonda è facoltativa */ }
}

let unsubFrames: (() => void) | null = null;
let pollId: ReturnType<typeof setInterval> | null = null;

function start(): void {
  unsubFrames = subscribeFrames(
    (frame) => {
      const f = frame as {
        type?: string; maxAgentsAuto?: boolean; maxAgents?: number;
        agentCostCapCents?: number; agentCostCapCents24h?: number;
      } | null;
      if (!f || f.type !== 'board:global-cap') return;
      adoptGlobalCap(f);
      adoptSpend(f);
    },
    { types: ['board:global-cap'] },
  );
  void refreshCap();
  void refreshCapacity();
  pollId = setInterval(() => {
    void refreshCapacity();
    // The SPEND is re-read like the machine, and for the same reason: it moves on
    // its own while nobody touches anything. The cap arrives by broadcast.
    void refreshCap();
  }, CAPACITY_POLL_MS);
}

function stop(): void {
  unsubFrames?.();
  unsubFrames = null;
  if (pollId !== null) clearInterval(pollId);
  pollId = null;
}

export function subscribeGlobalDispatchCap(listener: Listener): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

/** Lo stato condiviso, per un componente. Ogni montaggio in più costa un
 *  ascoltatore, non una fetch. */
export function useGlobalDispatchCap(): GlobalDispatchCapState {
  return useSyncExternalStore(
    subscribeGlobalDispatchCap,
    getGlobalDispatchCapState,
    getGlobalDispatchCapState,
  );
}
