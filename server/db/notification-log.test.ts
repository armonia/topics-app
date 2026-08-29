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
import { configureNotificationRegistry, markTargetSeenAndAnnounce, recordAndAnnounce, __resetNotificationRegistry } from "../notification-registry";
import { createTaskService } from "../services/tasks";
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
      announceSeen: () => {},
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
    configureNotificationRegistry({ announce: () => { calls++; }, announceSeen: () => {}, isTopicArchived: () => false });
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

/**
 * THE OTHER TWO GESTURES. Reading a chat was the only one the registry knew
 * about; a card leaving review and a terminal being opened are the two that
 * account for the rest of the backlog measured on 2026-08-29 - 74 `task-review`
 * rows and 325 `session` rows out of 400 unseen.
 *
 * The task case needs nothing new: the group key of a target is `kind:id`, so
 * `("task", id)` already addresses it. The terminal case does: a terminal is
 * not a target (there is no route that selects one tab), so its rows are born
 * with an explicit `groupKey` instead.
 *
 * @covers NOTIF-SEEN-01
 */
describe("markTargetNotificationsSeen — task e terminali, non solo le chat", () => {
  test("a card leaving review clears its own review row and nothing else", () => {
    wipe();
    recordNotification({ kind: "task-review", title: "mia", body: "", targetKind: "task", targetId: "task-1", dedupeKey: "task-review:task-1" });
    recordNotification({ kind: "task-review", title: "altrui", body: "", targetKind: "task", targetId: "task-2", dedupeKey: "task-review:task-2" });
    expect(countUnseenNotifications()).toBe(2);

    expect(markTargetNotificationsSeen("task", "task-1")).toBe(1);
    expect(countUnseenNotifications()).toBe(1);
    expect(listNotifications().find((r) => r.seenAt === null)?.targetId).toBe("task-2");
  });

  test("a parked card and its review row are the same target, so one gesture clears both", () => {
    // Both are `task:<id>`: this is the reason not to invent a second notion of
    // grouping - the card is one thing to look at, whatever woke it.
    wipe();
    recordNotification({ kind: "task-review", title: "consegnata", body: "", targetKind: "task", targetId: "task-9", dedupeKey: "task-review:task-9" });
    recordNotification({ kind: "task-parked", title: "domanda", body: "", targetKind: "task", targetId: "task-9", dedupeKey: "task-parked:task-9" });
    expect(markTargetNotificationsSeen("task", "task-9")).toBe(2);
    expect(countUnseenNotifications()).toBe(0);
  });

  test("opening a terminal clears the rows born with its own group key", () => {
    wipe();
    recordNotification({ kind: "session", title: "finito", body: "", dedupeKey: "terminal:a-1", groupKey: "terminal:sess-a" });
    recordNotification({ kind: "session", title: "finito ancora", body: "", dedupeKey: "terminal:a-2", groupKey: "terminal:sess-a" });
    recordNotification({ kind: "session", title: "un altro", body: "", dedupeKey: "terminal:b-1", groupKey: "terminal:sess-b" });
    expect(countUnseenNotifications()).toBe(3);

    expect(markTargetNotificationsSeen("terminal", "sess-a")).toBe(2);
    expect(countUnseenNotifications()).toBe(1);
  });

  test("a session row born WITHOUT a group key stays unreachable - which is why it gets one", () => {
    // This is the defect itself, kept as a test: 325 rows written this way were
    // extinguishable by nothing. It documents that the fix has to happen at
    // birth, not at the gesture.
    wipe();
    recordNotification({ kind: "session", title: "orfana", body: "", dedupeKey: "terminal:orphan" });
    expect(markTargetNotificationsSeen("terminal", "orphan")).toBe(0);
    expect(countUnseenNotifications()).toBe(1);
  });
});

/**
 * THE WHOLE CHAIN, over the real migrations: a card leaves review and its bell
 * goes quiet by itself. This is the only place it can be measured - the task
 * service's own bench runs on a separate in-memory handle that the notification
 * registry cannot see, so an assertion there would be green over a dead wire.
 *
 * @covers NOTIF-SEEN-01
 */
describe("una card che esce da review spegne la propria campanella", () => {
  const project = "proj-seen";

  function bench() {
    wipe();
    const db = getDatabase();
    db.run("DELETE FROM tasks");
    return createTaskService(db);
  }

  function inReview(s: ReturnType<typeof createTaskService>) {
    const t = s.create({ projectId: project, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "consegna" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    recordNotification({
      kind: "task-review", title: "da rivedere", body: "",
      targetKind: "task", targetId: t.id, dedupeKey: `task-review:${t.id}`,
    });
    expect(countUnseenNotifications()).toBe(1);
    return t;
  }

  test("approving it (reviewDecision) clears the row", () => {
    const s = bench();
    const t = inReview(s);
    s.reviewDecision({ taskId: t.id, by: "human", decision: "approve" });
    expect(countUnseenNotifications()).toBe(0);
  });

  test("rejecting it clears the row too - it has been looked at either way", () => {
    const s = bench();
    const t = inReview(s);
    s.reviewDecision({ taskId: t.id, by: "human", decision: "reject", comment: "no" });
    expect(countUnseenNotifications()).toBe(0);
  });

  test("dragging it out of review on the board clears it as well", () => {
    // The exit that is NOT `reviewDecision`: `update({status})` from the board
    // or from MCP. It was the strand that left 74 rows lit.
    const s = bench();
    const t = inReview(s);
    s.update({ taskId: t.id, actor: "human", by: "human", patch: { status: "backlog" } });
    expect(countUnseenNotifications()).toBe(0);
  });

  test("entering review does NOT clear anything", () => {
    // The half that keeps it honest: only leaving is a gesture of having looked.
    const s = bench();
    inReview(s);
    expect(countUnseenNotifications()).toBe(1);
  });

  test("markTargetSeenAndAnnounce announces once, and stays silent when it changed nothing", () => {
    wipe();
    let announced = 0;
    configureNotificationRegistry({
      announce: () => {}, announceSeen: () => { announced++; }, isTopicArchived: () => false,
    });
    recordNotification({ kind: "task-review", title: "x", body: "", targetKind: "task", targetId: "t-x", dedupeKey: "task-review:t-x" });
    expect(markTargetSeenAndAnnounce("task", "t-x")).toBe(1);
    expect(markTargetSeenAndAnnounce("task", "t-x")).toBe(0);
    expect(announced, "un fronte che non cambia niente sveglia ogni client per nulla").toBe(1);
    __resetNotificationRegistry();
  });
});
