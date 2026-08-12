/**
 * Downloads di una pane browser nativa — la LISTA, senza React intorno.
 *
 * Il Rust manda due eventi per download (start / done, vedi DOWNLOAD_EVENTS in
 * desktop-tauri/src-tauri/src/lib.rs): qui si trasformano in un elenco stabile.
 * Le regole stanno in una funzione pura perché sono le uniche cose di questo
 * pezzo che possono sbagliare in silenzio — e così si testano senza montare una
 * webview nativa.
 *
 * Contratto:
 *  - la voce NON scade da sola. Prima spariva dopo 30s (la vecchia strip in
 *    fondo alla pane): un download finito mentre guardavi altrove non lasciava
 *    traccia, ed è metà del «i download non vanno». Si toglie a mano (X) o si
 *    svuota l'elenco;
 *  - un `done` senza il suo `start` non si perde: diventa comunque una voce
 *    (succede se la pane è stata ricreata fra i due eventi);
 *  - l'elenco è limitato: le voci CHIUSE più vecchie cadono per prime, quelle
 *    ancora in corso non vengono mai buttate via.
 */

export type DownloadState = 'progressing' | 'completed' | 'interrupted' | 'cancelled';

export interface DownloadEntry {
  id: string;
  url: string;
  filename: string;
  state: DownloadState;
  savedPath?: string;
}

/** Un evento come arriva da `browser_take_download_events`. */
export interface DownloadEventIn {
  kind: string; // 'start' | 'done'
  id: string;
  url: string;
  filename: string;
  success: boolean;
  state: string;
  savedPath: string;
}

export const MAX_DOWNLOAD_ENTRIES = 20;

export function isDone(d: DownloadEntry): boolean {
  return d.state !== 'progressing';
}

function normalizeState(raw: string, success: boolean): DownloadState {
  if (raw === 'completed' || raw === 'interrupted' || raw === 'cancelled' || raw === 'progressing') {
    return raw;
  }
  return success ? 'completed' : 'interrupted';
}

/** Nome mostrato: quello dato dal Rust, altrimenti l'ultimo pezzo del path
 *  salvato, altrimenti l'ultimo pezzo dell'URL. Mai vuoto. */
export function displayName(ev: { filename?: string; savedPath?: string; url?: string }): string {
  const fromEvent = (ev.filename || '').trim();
  if (fromEvent) return fromEvent;
  const fromPath = (ev.savedPath || '').split('/').filter(Boolean).pop();
  if (fromPath) return fromPath;
  try {
    const last = new URL(ev.url || '').pathname.split('/').filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch { /* url non parsabile */ }
  return 'download';
}

/** Applica un evento all'elenco. Ritorna SEMPRE un array nuovo (o lo stesso, se
 *  l'evento non cambia niente), le voci più recenti in testa. */
export function applyDownloadEvent(list: DownloadEntry[], ev: DownloadEventIn): DownloadEntry[] {
  const existing = list.find((d) => d.id === ev.id);

  if (ev.kind === 'start') {
    // Ri-consegna dello stesso start (poll doppio, pane rimontata): non duplicare.
    if (existing) return list;
    const entry: DownloadEntry = {
      id: ev.id,
      url: ev.url,
      filename: displayName(ev),
      state: 'progressing',
      savedPath: ev.savedPath || undefined,
    };
    return capDownloads([entry, ...list]);
  }

  const state = normalizeState(ev.state, ev.success);
  if (!existing) {
    // `done` orfano — la voce nasce già chiusa invece di sparire nel nulla.
    const entry: DownloadEntry = {
      id: ev.id,
      url: ev.url,
      filename: displayName(ev),
      state,
      savedPath: ev.savedPath || undefined,
    };
    return capDownloads([entry, ...list]);
  }
  return list.map((d) =>
    d.id === ev.id
      ? {
          ...d,
          state,
          savedPath: ev.savedPath || d.savedPath,
          filename: d.filename || displayName(ev),
        }
      : d,
  );
}

/** Tetto all'elenco: cadono prima le voci chiuse più vecchie; se sono tutte in
 *  corso non si butta niente (un download vivo non si cancella da solo). */
export function capDownloads(list: DownloadEntry[], max = MAX_DOWNLOAD_ENTRIES): DownloadEntry[] {
  if (list.length <= max) return list;
  const out = [...list];
  for (let i = out.length - 1; i >= 0 && out.length > max; i--) {
    if (isDone(out[i])) out.splice(i, 1);
  }
  return out;
}

/** Dimensione leggibile per la riga di dettaglio. `undefined` in, `undefined`
 *  out: una voce senza dimensione mostra il suo stato, non «0 B». */
export function formatSize(bytes?: number): string | undefined {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes) || bytes < 0) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Quanti sono ancora in corso — è il numero che va sul bottone della toolbar. */
export function activeCount(list: DownloadEntry[]): number {
  return list.reduce((n, d) => (d.state === 'progressing' ? n + 1 : n), 0);
}
