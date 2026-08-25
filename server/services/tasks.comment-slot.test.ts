/**
 * A state note is ONE slot, not a pile.
 *
 * `preview-manager` runs again on every review transition and on every comment
 * carrying attachments, and each run wrote a new note. The card's thread grew a
 * new "preview" line every time, which is the noise the review section is
 * supposed to be free of. Worse than noise: the screenshot always lands in the
 * same file (`<taskId8>.png`), so the OLDER notes started rendering the NEWER
 * image. The thread did not merely repeat itself, it misdescribed what the card
 * looked like when each line was written.
 *
 * `replaces` empties the slot before filling it, keyed on the shared prefix
 * plus author plus kind. These tests hold the three edges that make that safe:
 * the text CHANGES between writes (so `once`, which dedupes identical text,
 * could never have caught it), a different author is not the same slot, and a
 * human comment that happens to start with the same words is never touched.
 *
 * @covers THREAD-04
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { freshDb } from "./tasks-test-db";
import { PREVIEW_NOTE_PREFIX as SLOT } from "./preview-manager";

const PID = "topics-app-abc123";

describe("commento a slot", () => {
  let db: Database; let s: TaskService; let taskId: string;
  beforeEach(() => {
    db = freshDb();
    let n = 0;
    s = createTaskService(db, { now: () => "2026-08-21T09:00:00.000Z", uuid: () => `id-${++n}` });
    taskId = s.create({ projectId: PID, text: "Una card qualunque" }).id;
  });

  const note = (): Array<{ content: string }> =>
    db.prepare("SELECT content FROM task_comments WHERE task_id = ? ORDER BY created_at").all(taskId) as Array<{ content: string }>;

  test("tre giri di anteprima lasciano UNA riga, l'ultima", () => {
    for (const porta of [3400, 3401, 3402]) {
      s.addComment({
        taskId, author: "verifier", kind: "review-note", replaces: SLOT,
        content: `${SLOT} viva e pronta su http://localhost:${porta}/`,
      });
    }
    const righe = note();
    expect(righe).toHaveLength(1);
    expect(righe[0]!.content).toContain("3402");
  });

  test("senza `replaces` si accumulano: e' il comportamento di prima", () => {
    for (const porta of [3400, 3401, 3402]) {
      s.addComment({
        taskId, author: "verifier", kind: "review-note",
        content: `${SLOT} viva e pronta su http://localhost:${porta}/`,
      });
    }
    expect(note()).toHaveLength(3);
  });

  test("un commento umano che comincia con le stesse parole resta dov'e'", () => {
    s.addComment({ taskId, author: "user", content: `${SLOT} questa non la tocca nessuno` });
    s.addComment({
      taskId, author: "verifier", kind: "review-note", replaces: SLOT,
      content: `${SLOT} viva e pronta su http://localhost:3400/`,
    });
    const righe = note();
    expect(righe).toHaveLength(2);
    expect(righe[0]!.content).toContain("non la tocca nessuno");
  });

  test("un altro `kind` e' un altro slot", () => {
    s.addComment({ taskId, author: "verifier", kind: "service", replaces: SLOT, content: `${SLOT} non allegata.` });
    s.addComment({ taskId, author: "verifier", kind: "review-note", replaces: SLOT, content: `${SLOT} viva su 3400.` });
    expect(note()).toHaveLength(2);
  });

  test("il testo CAMBIA a ogni giro: `once` non poteva bastare", () => {
    // `once` dedupes identical text. Here the url changes every time, so
    // every line was new to it: that is why the defect survived a mechanism
    // that looked like it covered the case.
    s.addComment({ taskId, author: "verifier", kind: "review-note", once: true, content: `${SLOT} su 3400` });
    s.addComment({ taskId, author: "verifier", kind: "review-note", once: true, content: `${SLOT} su 3401` });
    expect(note()).toHaveLength(2);
  });
});

describe("uno slot con piu' aperture", () => {
  let db2: Database; let s2: TaskService; let id2: string;
  beforeEach(() => {
    db2 = freshDb();
    let n = 0;
    s2 = createTaskService(db2, { now: () => "2026-08-21T09:00:00.000Z", uuid: () => `id2-${++n}` });
    id2 = s2.create({ projectId: PID, text: "Card con una nota vecchia" }).id;
  });

  const rows = () =>
    db2.prepare("SELECT content FROM task_comments WHERE task_id = ?").all(id2) as Array<{ content: string }>;

  test("la nota nuova riconosce l'apertura VECCHIA e la sostituisce", () => {
    // The real state of a035f945: a note written by yesterday's code...
    s2.addComment({ taskId: id2, author: "verifier", kind: "review-note", content: "Anteprima viva pronta: http://localhost:3400/" });
    // ...and the same thing said in today's words.
    s2.addComment({
      taskId: id2, author: "verifier", kind: "review-note",
      replaces: ["Anteprima:", "Anteprima viva"],
      content: "Anteprima: viva e pronta su http://localhost:3401/",
    });
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]!.content).toContain("3401");
  });

  test("con una sola apertura le due convivono: e' il difetto di partenza", () => {
    s2.addComment({ taskId: id2, author: "verifier", kind: "review-note", content: "Anteprima viva pronta: http://localhost:3400/" });
    s2.addComment({
      taskId: id2, author: "verifier", kind: "review-note",
      replaces: "Anteprima:",
      content: "Anteprima: viva e pronta su http://localhost:3401/",
    });
    expect(rows()).toHaveLength(2);
  });
});
