/**
 * Il registro delle WKWebView native aperte da questa app, e la regola per
 * riconoscere quelle che nessuno possiede più.
 *
 * IL BUCO CHE CHIUDE. Ogni pane browser è una webview FIGLIA della finestra
 * `main` (`lib.rs` → `window.add_child`). `useTauriBrowser` la distrugge
 * correttamente allo smontaggio (`browser_close`, dopo una grazia di 350 ms) —
 * ma un `location.reload()` non è uno smontaggio: distrugge il contesto JS
 * senza far girare nessuna cleanup, E non tocca le webview figlie, che
 * appartengono alla finestra e non alla pagina. Il risultato è che ogni ⌘R
 * lascia in giro una WKWebView per ogni pane browser aperta, senza più un
 * proprietario React e senza che nessun `browser_close` futuro le nomini mai.
 *
 * I punti di reload sono quattro e sono tutti ordinari: la scorciatoia ⌘R, il
 * bottone nella status bar, il popover di versione, e l'auto-guarigione del
 * bundle stantìo in `main.tsx` — che scatta DA SOLA. Misurato sull'app viva il
 * 2026-07-29: **65 processi WebContent, 61 dei quali con zero CPU, per 11,7 GB
 * di footprint**. Il conto era arrivato a 14 GB.
 *
 * COME. Il roster è persistito in `localStorage`, quindi sopravvive proprio a
 * ciò che causa il problema. Ogni apertura ci scrive la sua chiave con l'EPOCA
 * del caricamento di pagina corrente; ogni chiusura la toglie. Al boot l'epoca
 * cambia, e una voce rimasta con un'epoca vecchia è per DEFINIZIONE senza
 * proprietario: non è un'euristica sull'età o sulla memoria, è una tautologia —
 * la pagina che l'aveva aperta non esiste più.
 *
 * Una pane che si rimonta dopo il reload riscrive la sua chiave con l'epoca
 * nuova, quindi si toglie da sola dalla lista dei condannati: il reaper non ha
 * bisogno di sapere quali pane esistono, gli basta chi ha parlato di recente.
 */

const STORAGE_KEY = 'topics:native-browser-roster';

export interface RosterEntry {
  id: string;
  /** L'epoca del caricamento di pagina che ha aperto questa webview. */
  epoch: string;
}

/**
 * L'epoca di QUESTO caricamento di pagina. Nuova a ogni boot — un reload la
 * cambia, che è esattamente il segnale che serve. Niente `Date.now()` da solo:
 * due reload nello stesso millisecondo darebbero la stessa epoca e i loro
 * orfani si mimetizzerebbero a vicenda.
 */
export const PAGE_EPOCH: string = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function read(): RosterEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RosterEntry =>
        !!e && typeof e === 'object' &&
        typeof (e as RosterEntry).id === 'string' &&
        typeof (e as RosterEntry).epoch === 'string',
    );
  } catch {
    // localStorage negato o JSON corrotto: un roster vuoto non fa danni — il
    // reaper semplicemente non trova nulla da chiudere.
    return [];
  }
}

function write(entries: RosterEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* quota o modalità privata: si perde la traccia, non la correttezza */
  }
}

/** Una webview è stata aperta (o riusata) da questa pagina. */
export function recordBrowserView(id: string): void {
  const entries = read().filter((e) => e.id !== id);
  entries.push({ id, epoch: PAGE_EPOCH });
  write(entries);
}

/** La webview è stata chiusa per le vie normali: esce dal roster. */
export function forgetBrowserView(id: string): void {
  const entries = read();
  const next = entries.filter((e) => e.id !== id);
  if (next.length !== entries.length) write(next);
}

export function readRoster(): RosterEntry[] {
  return read();
}

/**
 * Le chiavi da chiudere: quelle aperte da un caricamento di pagina PRECEDENTE e
 * di cui nessuna pane viva ha ancora rivendicato la proprietà.
 *
 * Pura di proposito — è l'unico pezzo che vale la pena testare, e testarlo
 * richiede solo tre liste.
 *
 * @param live le chiavi che una pane MONTATA sta usando adesso. Una pane che si
 *   rimonta dopo il reload riscrive comunque la sua voce con l'epoca corrente,
 *   quindi questo parametro è una cintura oltre alle bretelle: copre la finestra
 *   fra il montaggio e la scrittura del roster.
 */
export function decideOrphans(
  entries: readonly RosterEntry[],
  currentEpoch: string,
  live: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.epoch === currentEpoch) continue; // aperta da questa pagina: viva
    if (live.has(e.id)) continue; // già ripresa in carico da una pane montata
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e.id);
  }
  return out;
}

/** Le pane browser MONTATE adesso. Non persistito: muore col caricamento. */
const liveViews = new Set<string>();

export function markBrowserViewLive(id: string): void {
  liveViews.add(id);
}
export function markBrowserViewDead(id: string): void {
  liveViews.delete(id);
}
export function liveBrowserViews(): ReadonlySet<string> {
  return liveViews;
}
