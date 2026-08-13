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
  /** Byte gia' sul disco. Il Rust li legge dalla dimensione del file che
   *  WKDownload sta scrivendo, quindi non c'e' nessuna seconda richiesta al
   *  server. Assente = non ancora misurati. */
  received?: number;
  /** Byte totali attesi, quando il sistema li dice. Assente di proposito quando
   *  non si sanno: e' cio' che distingue una barra vera da una inventata. */
  total?: number;
}

/** Una misura come arriva da `browser_download_progress`. `total` vale -1 quando
 *  il totale non e' conoscibile senza richiedere di nuovo il file. */
export interface DownloadProgressIn {
  id: string;
  received: number;
  total: number;
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

/**
 * Le misure di avanzamento entrano nell'elenco.
 *
 * Tocca SOLO le voci ancora in corso. Una voce finita ha gia' la sua risposta
 * («Completato» e il path), e il file sul disco continuerebbe a rispondere alla
 * domanda sbagliata: dopo la fine i byte letti sono la dimensione finale, non un
 * avanzamento. Una misura senza voce viene scartata invece di creare una riga:
 * l'elenco nasce dagli eventi, e un id che non conosciamo e' un download di una
 * pane che non e' piu' questa.
 *
 * Ritorna la STESSA lista quando niente e' cambiato. Questo poll gira ogni
 * secondo e la sua risposta e' quasi sempre identica alla precedente: un array
 * nuovo a ogni giro farebbe ridisegnare il menu per nulla.
 */
export function applyDownloadProgress(list: DownloadEntry[], msgs: DownloadProgressIn[]): DownloadEntry[] {
  if (!msgs.length) return list;
  let changed = false;
  const out = list.map((d) => {
    if (d.state !== 'progressing') return d;
    const m = msgs.find((x) => x.id === d.id);
    if (!m) return d;
    // Sotto zero e' il modo con cui il Rust dice «non lo so»: il file non c'e'
    // ancora, oppure il totale non e' ricavabile. Si tiene il valore di prima.
    const received = Number.isFinite(m.received) && m.received >= 0 ? m.received : d.received;
    const total = Number.isFinite(m.total) && m.total > 0 ? m.total : d.total;
    if (received === d.received && total === d.total) return d;
    changed = true;
    return { ...d, received, total };
  });
  return changed ? out : list;
}

/**
 * La percentuale da mostrare, 0..100 intera, oppure `undefined`.
 *
 * `undefined` non e' un caso di errore, e' meta' della funzione: senza totale la
 * barra non si puo' disegnare, e il menu mostra i byte trasferiti. Il Rust
 * rinuncia al totale ogni volta che dovrebbe indovinarlo, e questa regola tiene
 * quella scelta fino allo schermo. Si arrotonda per DIFETTO: un «100%» su un
 * download ancora in corso e' il modo piu' rapido di far sembrare bloccata una
 * cosa che sta funzionando.
 */
export function downloadPercent(d: Pick<DownloadEntry, 'received' | 'total'>): number | undefined {
  const total = d.total;
  const received = d.received;
  if (!total || !Number.isFinite(total) || total <= 0) return undefined;
  if (received === undefined || !Number.isFinite(received) || received < 0) return undefined;
  return Math.max(0, Math.min(100, Math.floor((received / total) * 100)));
}

/** «3,2 MB di 10 MB», oppure i soli byte trasferiti quando il totale non si sa,
 *  oppure `undefined` quando non c'e' ancora niente da dire. E' la riga di
 *  dettaglio di una voce in corso. */
export function formatProgress(d: Pick<DownloadEntry, 'received' | 'total'>): string | undefined {
  const got = formatSize(d.received);
  if (got === undefined) return undefined;
  const all = d.total !== undefined && d.total > 0 ? formatSize(d.total) : undefined;
  return all ? `${got} di ${all}` : got;
}

/** Quanti sono ancora in corso — è il numero che va sul bottone della toolbar. */
export function activeCount(list: DownloadEntry[]): number {
  return list.reduce((n, d) => (d.state === 'progressing' ? n + 1 : n), 0);
}
