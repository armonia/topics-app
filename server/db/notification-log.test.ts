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
  countUnseenNotifications,
  listNotifications,
  markNotificationsSeen,
  markTargetNotificationsSeen,
  recordNotification,
} from "./notification-log";
import { configureNotificationRegistry, recordAndAnnounce, __resetNotificationRegistry } from "../notification-registry";
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

describe("il «visto»", () => {
  test("upTo azzera il contatore e ce lo lascia", () => {
    wipe();
    recordNotification({ kind: "other", title: "a", dedupeKey: "a" });
    recordNotification({ kind: "other", title: "b", dedupeKey: "b" });
    expect(countUnseenNotifications()).toBe(2);
    const newest = listNotifications()[0]!.createdAt;
    markNotificationsSeen({ upTo: newest });
    expect(countUnseenNotifications()).toBe(0);
    // Riletto da capo (è il "dopo un refresh"): resta zero, perché lo stato sta
    // sulla riga e non nella memoria di una finestra.
    expect(listNotifications().every((r) => r.seenAt !== null)).toBe(true);
  });

  test("vista UNA del gruppo, viste tutte — il contatore torna a zero", () => {
    wipe();
    const t0 = Date.now();
    // Due notifiche dello stesso topic: una notifica RAGGRUPPATA, cioè una cosa
    // sola da guardare. Distanziate oltre la finestra di dedup, altrimenti la
    // seconda non nascerebbe proprio.
    const first = recordNotification({ kind: "chat-message", title: "m1", dedupeKey: "chat:x", targetKind: "topic", targetId: "x" }, t0);
    recordNotification({ kind: "chat-message", title: "m2", dedupeKey: "chat:x", targetKind: "topic", targetId: "x" }, t0 + NOTIFICATION_DEDUPE_MS + 1);
    expect(countUnseenNotifications()).toBe(2);
    markNotificationsSeen({ ids: [first!.id] });
    // Senza la cascata sul gruppo qui resterebbe 1 — ed è esattamente il difetto
    // per cui il contatore non tornava mai a zero.
    expect(countUnseenNotifications()).toBe(0);
  });

  test("una chiamata senza ids né upTo non tocca niente", () => {
    wipe();
    recordNotification({ kind: "other", title: "a", dedupeKey: "a" });
    expect(markNotificationsSeen({})).toBe(0);
    expect(countUnseenNotifications()).toBe(1);
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

describe("recordAndAnnounce — il cancello degli archiviati", () => {
  test("un topic archiviato non entra nel registro, e nessuno lo annuncia", () => {
    wipe();
    const announced: string[] = [];
    configureNotificationRegistry({
      announce: (row) => { announced.push(row.title); },
      isTopicArchived: (id) => id === "archiviato",
    });
    const dead = recordAndAnnounce({ kind: "chat-message", title: "rumore", dedupeKey: "chat:archiviato", targetKind: "topic", targetId: "archiviato" });
    const alive = recordAndAnnounce({ kind: "chat-message", title: "vivo", dedupeKey: "chat:vivo", targetKind: "topic", targetId: "vivo" });
    expect(dead).toBeNull();
    expect(alive).not.toBeNull();
    expect(announced).toEqual(["vivo"]);
    __resetNotificationRegistry();
  });

  test("un doppione non viene annunciato una seconda volta", () => {
    wipe();
    let calls = 0;
    configureNotificationRegistry({ announce: () => { calls++; }, isTopicArchived: () => false });
    recordAndAnnounce({ kind: "task-review", title: "T", dedupeKey: "task-review:t9" });
    recordAndAnnounce({ kind: "task-review", title: "T", dedupeKey: "task-review:t9" });
    expect(calls).toBe(1);
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

  test("segna viste TUTTE le notifiche di quella chat", () => {
    wipe();
    notifica("t1", "primo");
    notifica("t1", "secondo");
    expect(countUnseenNotifications()).toBe(2);

    expect(markTargetNotificationsSeen("topic", "t1")).toBe(2);
    expect(countUnseenNotifications()).toBe(0);
  });

  test("NON tocca le notifiche delle altre chat", () => {
    // E' il caso che rende la sincronia sicura invece che comoda: leggere una
    // conversazione non puo' cancellare l'avviso di un'altra, o il contatore
    // diventa una decorazione.
    wipe();
    notifica("t1", "mia");
    notifica("t2", "di un altro");

    expect(markTargetNotificationsSeen("topic", "t1")).toBe(1);
    expect(countUnseenNotifications()).toBe(1);
    expect(listNotifications().find((r) => r.seenAt === null)?.targetId).toBe("t2");
  });

  test("torna ZERO quando non c'e' niente da segnare", () => {
    // Il chiamante lo usa per NON mandare un broadcast: un `notification:seen`
    // che non cambia niente sveglia ogni client connesso, gli fa validare il
    // frame e ri-renderizzare. La rotta della lettura evita gia' lo stesso
    // costo sul non-letto, e sarebbe strano reintrodurlo nella riga accanto.
    wipe();
    notifica("t1", "una");
    expect(markTargetNotificationsSeen("topic", "t1")).toBe(1);
    expect(markTargetNotificationsSeen("topic", "t1"), "gia' viste").toBe(0);
    expect(markTargetNotificationsSeen("topic", "mai-vista"), "bersaglio sconosciuto").toBe(0);
  });

  test("un bersaglio senza id non segna niente invece di segnare tutto", () => {
    // `group_key` nullo vuol dire «non raggruppabile». Trattarlo come un jolly
    // cancellerebbe l'intera cronologia al primo id vuoto: il tipo di errore
    // che si scopre quando la campanella non si accende piu'.
    wipe();
    notifica("t1", "una");
    expect(markTargetNotificationsSeen("topic", "")).toBe(0);
    expect(countUnseenNotifications()).toBe(1);
  });
});
