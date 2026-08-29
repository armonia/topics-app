// La CRONOLOGIA delle notifiche, lato client: la porta HTTP e le due decisioni
// pure che la governano.
//
// Il registro vive sul server (migration 102) e non nel browser, di proposito:
// una notifica può partire da una finestra e vederla è naturale da un'altra (o
// dal telefono), e un contatore per-finestra sarebbe un numero diverso per ogni
// scheda aperta. Qui dentro non c'è stato: lo tiene `useNotificationHistory`.

import type {
  NotificationRecordInput,
  NotificationRow,
} from '../../../../shared/notification-log';

export interface NotificationHistoryPage {
  rows: NotificationRow[];
  unseen: number;
}

/** Le ultime righe + quante non viste. */
export async function fetchNotificationHistory(opts: { limit?: number; before?: string } = {}): Promise<NotificationHistoryPage> {
  const q = new URLSearchParams();
  if (opts.limit) q.set('limit', String(opts.limit));
  if (opts.before) q.set('before', opts.before);
  const qs = q.toString();
  const r = await fetch(`/api/notifications${qs ? `?${qs}` : ''}`);
  if (!r.ok) throw new Error(`GET /api/notifications ${r.status}`);
  const data = (await r.json()) as Partial<NotificationHistoryPage>;
  return { rows: Array.isArray(data.rows) ? data.rows : [], unseen: data.unseen ?? 0 };
}

/**
 * Registra una notifica APPENA MANDATA.
 *
 * Fire-and-forget, e senza `await` nel chiamante: la notifica è già partita: il
 * registro è la sua traccia, non la sua consegna. Un server irraggiungibile
 * deve costare una riga di cronologia mancante, mai un banner in meno.
 */
export function recordNotificationSent(input: NotificationRecordInput): void {
  try {
    void fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* mai propagare: il registro non può rompere la notifica */
  }
}

/**
 * Mark seen BY TARGET: "I looked at this thing", not "I looked at the list".
 * Fire-and-forget like `recordNotificationSent` - the real gesture is opening
 * the terminal, and it must not be able to fail because the registry did not
 * answer.
 */
export function markTargetSeen(targetKind: string, targetId: string): void {
  try {
    void fetch('/api/notifications/seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetKind, targetId }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* never propagate: the registry must not break opening a tab */
  }
}

/** Segna viste: tutte fino a un istante, e/o alcune righe puntuali. */
export async function markNotificationsSeen(body: { ids?: string[]; upTo?: string }): Promise<number> {
  const r = await fetch('/api/notifications/seen', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST /api/notifications/seen ${r.status}`);
  const data = (await r.json()) as { unseen?: number };
  return data.unseen ?? 0;
}

// ── Decisioni pure ──────────────────────────────────────────────────────────

/**
 * Inserisci in testa la riga arrivata dal fronte `notification:new`, senza
 * duplicarla.
 *
 * Il controllo sull'id NON è teorico: la finestra che ha appena fatto il POST
 * riceve la riga DUE volte — una come risposta HTTP, una come broadcast — e
 * senza questo la stessa notifica comparirebbe due volte in cima alla lista di
 * chi l'ha generata e una sola volta a tutti gli altri.
 */
export function mergeNotificationRow(rows: NotificationRow[], row: NotificationRow, cap = 200): NotificationRow[] {
  const without = rows.filter((r) => r.id !== row.id);
  return [row, ...without].slice(0, cap);
}

/**
 * «2 min», «3 h», «ieri». Il tempo relativo di una lista di notifiche: quello
 * che serve è QUANTO FA, non il timestamp — e a colpo d'occhio, perché queste
 * righe si scorrono, non si leggono.
 */
export function formatNotificationAge(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'adesso';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'ieri' : `${d} g`;
}
