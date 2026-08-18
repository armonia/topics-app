/**
 * Il REGISTRO delle notifiche — l'unico scrittore della tabella `notification_log`
 * (migration 102), e l'unico lettore che la cronologia usa.
 *
 * Le due porte che ci scrivono stanno una per parte: il banner nativo lo decide
 * il client (`useCompletionNotifier` → `fire` → POST /api/notifications), la
 * push la decide il server (`maybeSendPush`). Entrambe passano di qui, e di qui
 * passa anche la regola che le tiene distinte da un DOPPIONE — vedi
 * `NOTIFICATION_DEDUPE_MS` in shared/notification-log.ts.
 *
 * Regole di casa:
 *  - Scrivere è BEST-EFFORT: un registro che non riesce a scrivere non deve mai
 *    impedire alla notifica di partire. Ogni errore è un `console.warn`.
 *  - Il tetto e la scadenza si applicano a ogni inserimento (una COUNT indicizzata
 *    e al più due DELETE). Sono SCRITTI, non impliciti: 500 righe, 30 giorni.
 *  - `recordNotification` dice al chiamante se la riga è NUOVA. Serve: solo una
 *    riga nuova alza il contatore e merita il broadcast `notification:new`.
 */

import { getDatabase } from "../db";
import {
  NOTIFICATION_DEDUPE_MS,
  NOTIFICATION_MAX_AGE_DAYS,
  NOTIFICATION_MAX_ROWS,
  NOTIFICATION_PAGE_SIZE,
  defaultNotificationGroupKey,
  isNotificationKind,
  notificationTargetUrl,
  type NotificationRecordInput,
  type NotificationRow,
} from "../../shared/notification-log";

interface DbRow {
  id: string;
  created_at: string;
  kind: string;
  title: string;
  body: string;
  target_kind: string | null;
  target_id: string | null;
  target_url: string | null;
  source: string;
  group_key: string | null;
  seen_at: string | null;
}

function toRow(r: DbRow): NotificationRow {
  return {
    id: r.id,
    createdAt: r.created_at,
    kind: isNotificationKind(r.kind) ? r.kind : "other",
    title: r.title,
    body: r.body ?? "",
    targetKind: r.target_kind === "task" || r.target_kind === "topic" ? r.target_kind : null,
    targetId: r.target_id,
    targetUrl: r.target_url,
    source: r.source === "push" ? "push" : "banner",
    groupKey: r.group_key,
    seenAt: r.seen_at,
  };
}

/**
 * Scrivi una notifica nel registro. Torna la riga se è NUOVA, `null` se era un
 * doppione entro la finestra di dedup (o se la scrittura è fallita).
 *
 * Il dedup è un SELECT esplicito e non un `INSERT OR IGNORE` su un UNIQUE, per
 * due motivi indipendenti: l'unicità perpetua ingoierebbe per sempre la seconda
 * occorrenza legittima della stessa chiave (la review dello stesso task fra un
 * mese), e `INSERT OR IGNORE` non dice al chiamante SE ha inserito — cioè
 * proprio il fatto che qui serve per decidere il broadcast. Il server è un
 * processo solo con SQLite sincrono: fra il SELECT e l'INSERT non si infila
 * nessun altro.
 */
export function recordNotification(input: NotificationRecordInput, now = Date.now()): NotificationRow | null {
  try {
    const db = getDatabase();
    const cutoff = new Date(now - NOTIFICATION_DEDUPE_MS).toISOString();
    const dupe = db
      .query("SELECT id FROM notification_log WHERE dedupe_key = ? AND created_at > ? LIMIT 1")
      .get(input.dedupeKey, cutoff) as { id: string } | null;
    if (dupe) return null;

    const row: DbRow = {
      id: crypto.randomUUID(),
      created_at: new Date(now).toISOString(),
      kind: input.kind,
      title: input.title,
      body: input.body ?? "",
      target_kind: input.targetKind ?? null,
      target_id: input.targetId ?? null,
      target_url: notificationTargetUrl(input.targetKind, input.targetId),
      source: input.source ?? "banner",
      // Il gruppo di default è il BERSAGLIO: vedi `defaultNotificationGroupKey`.
      // Applicato QUI, cioè nell'unico punto che scrive, così nessuno dei due
      // scrittori può dimenticarselo e lasciare righe fuori da ogni gruppo.
      group_key: input.groupKey ?? defaultNotificationGroupKey(input.targetKind, input.targetId),
      seen_at: null,
    };
    db.run(
      `INSERT INTO notification_log
         (id, created_at, kind, title, body, target_kind, target_id, target_url, source, dedupe_key, group_key, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        row.id,
        row.created_at,
        row.kind,
        row.title,
        row.body,
        row.target_kind,
        row.target_id,
        row.target_url,
        row.source,
        input.dedupeKey,
        row.group_key,
      ],
    );
    enforceRetention(db, now);
    return toRow(row);
  } catch (err) {
    console.warn("[notification-log] insert failed:", (err as Error)?.message || err);
    return null;
  }
}

/**
 * Tetto + scadenza. Prima la scadenza (30 giorni), poi il tetto (500 righe):
 * l'ordine conta solo per il costo, non per il risultato.
 */
function enforceRetention(db: ReturnType<typeof getDatabase>, now: number): void {
  try {
    const oldest = new Date(now - NOTIFICATION_MAX_AGE_DAYS * 86_400_000).toISOString();
    db.run("DELETE FROM notification_log WHERE created_at < ?", [oldest]);
    const c = db.query("SELECT COUNT(*) AS c FROM notification_log").get() as { c: number } | null;
    const count = c?.c ?? 0;
    if (count <= NOTIFICATION_MAX_ROWS) return;
    db.run(
      `DELETE FROM notification_log WHERE id IN (
         SELECT id FROM notification_log ORDER BY created_at ASC LIMIT ?
       )`,
      [count - NOTIFICATION_MAX_ROWS],
    );
  } catch (err) {
    console.warn("[notification-log] retention failed:", (err as Error)?.message || err);
  }
}

/** Le ultime N righe, dalla più recente. `before` pagina all'indietro. */
export function listNotifications(opts: { limit?: number; before?: string } = {}): NotificationRow[] {
  try {
    const db = getDatabase();
    const limit = Math.min(Math.max(opts.limit ?? NOTIFICATION_PAGE_SIZE, 1), 200);
    const rows = opts.before
      ? (db
          .query("SELECT * FROM notification_log WHERE created_at < ? ORDER BY created_at DESC LIMIT ?")
          .all(opts.before, limit) as DbRow[])
      : (db.query("SELECT * FROM notification_log ORDER BY created_at DESC LIMIT ?").all(limit) as DbRow[]);
    return rows.map(toRow);
  } catch (err) {
    console.warn("[notification-log] list failed:", (err as Error)?.message || err);
    return [];
  }
}

/** Quante non ne hai ancora guardate. È il numero sul tastino. */
export function countUnseenNotifications(): number {
  try {
    const db = getDatabase();
    const r = db.query("SELECT COUNT(*) AS c FROM notification_log WHERE seen_at IS NULL").get() as
      | { c: number }
      | null;
    return r?.c ?? 0;
  } catch (err) {
    console.warn("[notification-log] count failed:", (err as Error)?.message || err);
    return 0;
  }
}

/**
 * Segna VISTO. Tre forme, e la terza è quella che chiude un difetto già pagato:
 *
 *  · `upTo`  → tutte le righe fino a quell'istante (è quello che fa l'apertura
 *    della cronologia: hai guardato la lista, l'hai guardata tutta).
 *  · `ids`   → righe puntuali (il click su una riga).
 *  · e SEMPRE, in coda, il CASCATA sul gruppo: segnare visto un membro segna
 *    visti tutti quelli con lo stesso `group_key`. Una notifica che raggruppa
 *    più eventi è UNA cosa da guardare; senza questo passaggio il contatore non
 *    torna mai a zero — è il cancello del «visto» che mancava sui rollup.
 *
 * Torna quante righe ha cambiato.
 */
/**
 * Le notifiche di UN BERSAGLIO, segnate viste tutte insieme.
 *
 * LEGGERE LA COSA E' AVERLA VISTA. Aprire una chat azzerava il suo non-letto
 * nella sidebar ma lasciava accesa la campanella: due contatori sullo stesso
 * fatto che dicevano cose diverse, e quello che restava acceso era quello che
 * nessun gesto naturale spegneva - si spegneva solo aprendo il pannello della
 * cronologia, che e' un posto in cui non si passa mai apposta.
 *
 * Riusa la chiave di gruppo (`topic:<id>`), che e' gia' l'unita' con cui la
 * cascata di `markNotificationsSeen` ragiona: una sola nozione di «queste
 * notifiche parlano della stessa cosa», non una seconda scritta qui.
 *
 * Torna quante righe ha toccato: zero e' il caso normale (niente da segnare) e
 * il chiamante lo usa per non svegliare i client con un broadcast inutile.
 */
export function markTargetNotificationsSeen(
  targetKind: string,
  targetId: string,
  now = Date.now(),
): number {
  const groupKey = defaultNotificationGroupKey(
    targetKind as NotificationRecordInput["targetKind"],
    targetId,
  );
  if (!groupKey) return 0;
  try {
    const db = getDatabase();
    const r = db.run(
      "UPDATE notification_log SET seen_at = ? WHERE seen_at IS NULL AND group_key = ?",
      [new Date(now).toISOString(), groupKey],
    );
    return Number(r?.changes ?? 0);
  } catch (err) {
    // Best-effort come il resto del registro: una campanella che resta accesa
    // e' un fastidio, una lettura che fallisce per colpa sua sarebbe un guasto.
    console.warn("[notification-log] mark target seen failed:", (err as Error)?.message || err);
    return 0;
  }
}

export function markNotificationsSeen(opts: { ids?: string[]; upTo?: string }, now = Date.now()): number {
  try {
    const db = getDatabase();
    const at = new Date(now).toISOString();
    let changed = 0;
    if (opts.upTo) {
      const r = db.run("UPDATE notification_log SET seen_at = ? WHERE seen_at IS NULL AND created_at <= ?", [
        at,
        opts.upTo,
      ]);
      changed += Number(r?.changes ?? 0);
    }
    const ids = (opts.ids ?? []).filter((s) => typeof s === "string" && s).slice(0, 500);
    if (ids.length) {
      const marks = ids.map(() => "?").join(",");
      const r = db.run(
        `UPDATE notification_log SET seen_at = ? WHERE seen_at IS NULL AND id IN (${marks})`,
        [at, ...ids],
      );
      changed += Number(r?.changes ?? 0);
      // La cascata sul gruppo: i compagni di `group_key` delle righe appena
      // segnate. Ristretta ai gruppi TOCCATI, non a tutta la tabella.
      const g = db.run(
        `UPDATE notification_log SET seen_at = ?
          WHERE seen_at IS NULL
            AND group_key IS NOT NULL
            AND group_key IN (SELECT group_key FROM notification_log WHERE id IN (${marks}) AND group_key IS NOT NULL)`,
        [at, ...ids],
      );
      changed += Number(g?.changes ?? 0);
    }
    return changed;
  } catch (err) {
    console.warn("[notification-log] mark seen failed:", (err as Error)?.message || err);
    return 0;
  }
}
