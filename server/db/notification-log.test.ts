/**
 * Il REGISTRO delle notifiche — prove sul writer.
 *
 * Qui si difendono le cinque cose che rendono la cronologia usabile invece che
 * un elenco che mente:
 *   1. il DEDUP a finestra (un evento, N mittenti → una riga; fra un mese la
 *      stessa chiave è un evento nuovo);
 *   2. il BERSAGLIO salvato al momento dell'invio (senza, il click non porta da
 *      nessuna parte);
 *   3. il «visto» che vale per TUTTO IL GRUPPO (il cancello che mancava sui
 *      rollup, per cui il contatore non tornava mai a zero);
 *   4. il TETTO e la SCADENZA, cioè la politica di retention scritta;
 *   5. il cancello dei topic ARCHIVIATI (che vive in notification-registry).
 *
 * DB in-memory su una tmpdir, come `activity-log.test.ts`: le migration vere
 * girano tali e quali, quindi la tabella sotto test è quella che va in
 * produzione.
  * @covers NOTIF-LOG-01
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase, closeDatabase, getDatabase } from "../db";
import {
  listNotifications,
  markGroupNotificationsSeen,
  markTargetNotificationsSeen,
  recordNotification,
} from "./notification-log";
import { configureNotificationRegistry, recordNotificationRow, __resetNotificationRegistry } from "../notification-registry";
import { NOTIFICATION_DEDUPE_MS, NOTIFICATION_MAX_AGE_DAYS, NOTIFICATION_MAX_ROWS } from "../../shared/notification-log";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "notification-log-test-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (!f.endsWith(".sql")) continue;
    writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
    initDatabase(tmpRoot);
});

afterAll(() => {
  try { closeDatabase(); } catch { /* già chiuso */ }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

function wipe(): void {
  getDatabase().run("DELETE FROM notification_log");
}

describe("recordNotification — dedup a finestra", () => {
  test("due mittenti dello stesso evento lasciano UNA riga", () => {
    wipe();
    const a = recordNotification({ kind: "task-review", title: "T", dedupeKey: "task-review:t1", targetKind: "task", targetId: "t1" });
    // La push, un istante dopo, con la stessa chiave: è lo stesso evento.
    const b = recordNotification({ kind: "task-review", title: "T", dedupeKey: "task-review:t1", source: "push" });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(listNotifications().length).toBe(1);
  });

  test("fuori dalla finestra la stessa chiave è un evento NUOVO", () => {
    wipe();
    const t0 = Date.now();
    recordNotification({ kind: "task-review", title: "T", dedupeKey: "task-review:t1" }, t0);
    const later = recordNotification({ kind: "task-review", title: "T", dedupeKey: "task-review:t1" }, t0 + NOTIFICATION_DEDUPE_MS + 1);
    expect(later).not.toBeNull();
    expect(listNotifications().length).toBe(2);
  });
});

describe("il bersaglio", () => {
  test("viene salvato come deep-link, non ricostruito dopo", () => {
    wipe();
    const task = recordNotification({ kind: "task-review", title: "T", dedupeKey: "k1", targetKind: "task", targetId: "abc" });
    const topic = recordNotification({ kind: "chat-message", title: "C", dedupeKey: "k2", targetKind: "topic", targetId: "xyz" });
    expect(task?.targetUrl).toBe("/task/abc");
    expect(topic?.targetUrl).toBe("/topic/xyz");
  });

  test("senza bersaglio la riga esiste ma non è cliccabile", () => {
    wipe();
    const row = recordNotification({ kind: "terminal", title: "Terminale", dedupeKey: "k3" });
    expect(row?.targetUrl).toBeNull();
    expect(row?.groupKey).toBeNull();
  });

  test("il gruppo di default è il bersaglio", () => {
    wipe();
    const row = recordNotification({ kind: "task-review", title: "T", dedupeKey: "k4", targetKind: "task", targetId: "abc" });
    expect(row?.groupKey).toBe("task:abc");
  });
});

describe("the seen of one subject (the seen door's writer)", () => {

  test("with `before`, a row written for a newer epoch stays unseen", () => {
    wipe();
    const t0 = Date.now();
    recordNotification({ kind: "chat-message", title: "old", dedupeKey: "chat:z", targetKind: "topic", targetId: "z" }, t0);
    const latest = recordNotification({ kind: "chat-message", title: "new", dedupeKey: "chat:z", targetKind: "topic", targetId: "z" }, t0 + NOTIFICATION_DEDUPE_MS + 1);
    expect(markGroupNotificationsSeen("topic:z", latest!.createdAt)).toBe(1);
    expect(listNotifications().find((r) => r.id === latest!.id)?.seenAt).toBeNull();
  });

});

describe("tetto e scadenza", () => {
  test("oltre il tetto restano le più recenti", () => {
    wipe();
    const t0 = Date.now() - NOTIFICATION_MAX_ROWS * 1000;
    for (let i = 0; i < NOTIFICATION_MAX_ROWS + 5; i++) {
      recordNotification({ kind: "other", title: `n${i}`, dedupeKey: `k${i}` }, t0 + i * 1000);
    }
    const c = getDatabase().query("SELECT COUNT(*) AS c FROM notification_log").get() as { c: number };
    expect(c.c).toBe(NOTIFICATION_MAX_ROWS);
    expect(listNotifications({ limit: 1 })[0]!.title).toBe(`n${NOTIFICATION_MAX_ROWS + 4}`);
  });

  test("le righe più vecchie della scadenza spariscono al primo inserimento", () => {
    wipe();
    const now = Date.now();
    recordNotification({ kind: "other", title: "vecchia", dedupeKey: "v" }, now - (NOTIFICATION_MAX_AGE_DAYS + 1) * 86_400_000);
    expect(listNotifications().length).toBe(1);
    recordNotification({ kind: "other", title: "nuova", dedupeKey: "n" }, now);
    const rows = listNotifications();
    expect(rows.length).toBe(1);
    expect(rows[0]!.title).toBe("nuova");
  });
});

describe("recordNotificationRow: the gate of the archived topics", () => {
  test("an archived topic does not enter the log", () => {
    wipe();
    configureNotificationRegistry({ isTopicArchived: (id) => id === "archiviato" });
    const dead = recordNotificationRow({ kind: "chat-message", title: "rumore", dedupeKey: "chat:archiviato", targetKind: "topic", targetId: "archiviato" });
    const alive = recordNotificationRow({ kind: "chat-message", title: "vivo", dedupeKey: "chat:vivo", targetKind: "topic", targetId: "vivo" });
    expect(dead).toBeNull();
    expect(alive).not.toBeNull();
    expect(listNotifications().map((r) => r.title)).toEqual(["vivo"]);
    __resetNotificationRegistry();
  });

  test("a duplicate is not written twice: the second call returns null", () => {
    wipe();
    configureNotificationRegistry({ isTopicArchived: () => false });
    expect(recordNotificationRow({ kind: "task-review", title: "T", dedupeKey: "task-review:t9" })).not.toBeNull();
    expect(recordNotificationRow({ kind: "task-review", title: "T", dedupeKey: "task-review:t9" })).toBeNull();
    __resetNotificationRegistry();
  });
});

/**
 * LEGGERE LA COSA E' AVERLA VISTA.
 *
 * Segnalato: «assicuriamoci che le notifiche siano effettivamente sincronizzate
 * con lo stato della notifica della sidebar».
 *
 * Aprire una chat azzerava il suo non-letto nella sidebar e lasciava accesa la
 * campanella in alto: due contatori sullo stesso fatto che dicevano cose
 * diverse. Il peggiore dei due era quello che restava acceso, perche' nessun
 * gesto naturale lo spegneva - solo aprire il pannello della cronologia, che e'
 * un posto in cui non si passa mai apposta. Un contatore che non si azzera da
 * se' smette di essere guardato, e da li' in poi non segnala piu' niente.
 */
describe("markTargetNotificationsSeen — leggere una chat spegne la sua campanella", () => {
  function notifica(targetId: string, titolo: string) {
    return recordNotification({
      kind: "chat-message", title: titolo, body: "",
      targetKind: "topic", targetId,
      dedupeKey: `${targetId}:${titolo}`,
    });
  }

  test("torna ZERO quando non c'e' niente da segnare", () => {
    // A no-op says so with zero: the caller can tell a seen that changed a row
    // from one that found nothing to mark.
    wipe();
    notifica("t1", "una");
    expect(markTargetNotificationsSeen("topic", "t1")).toBe(1);
    expect(markTargetNotificationsSeen("topic", "t1"), "gia' viste").toBe(0);
    expect(markTargetNotificationsSeen("topic", "mai-vista"), "bersaglio sconosciuto").toBe(0);
  });

});

