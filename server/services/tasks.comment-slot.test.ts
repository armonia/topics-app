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
 * `sostituisce` empties the slot before filling it, keyed on the shared prefix
 * plus author plus kind. These tests hold the three edges that make that safe:
 * the text CHANGES between writes (so `once`, which dedupes identical text,
 * could never have caught it), a different author is not the same slot, and a
 * human comment that happens to start with the same words is never touched.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { freshDb } from "./tasks-test-db";
import { PREFISSO_NOTA_ANTEPRIMA as SLOT } from "./preview-manager";

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
        taskId, author: "verifier", kind: "review-note", sostituisce: SLOT,
        content: `${SLOT} viva e pronta su http://localhost:${porta}/`,
      });
    }
    const righe = note();
    expect(righe).toHaveLength(1);
    expect(righe[0]!.content).toContain("3402");
  });

  test("senza `sostituisce` si accumulano: e' il comportamento di prima", () => {
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
      taskId, author: "verifier", kind: "review-note", sostituisce: SLOT,
      content: `${SLOT} viva e pronta su http://localhost:3400/`,
    });
    const righe = note();
    expect(righe).toHaveLength(2);
    expect(righe[0]!.content).toContain("non la tocca nessuno");
  });

  test("un altro `kind` e' un altro slot", () => {
    s.addComment({ taskId, author: "verifier", kind: "service", sostituisce: SLOT, content: `${SLOT} non allegata.` });
    s.addComment({ taskId, author: "verifier", kind: "review-note", sostituisce: SLOT, content: `${SLOT} viva su 3400.` });
    expect(note()).toHaveLength(2);
  });

  test("il testo CAMBIA a ogni giro: `once` non poteva bastare", () => {
    // `once` deduplica testo identico. Qui l'url cambia sempre, quindi ogni
    // riga era nuova per lui: e' il motivo per cui il difetto e' sopravvissuto
    // a un meccanismo che sembrava coprirlo. allow-italian: descrive il perche'
    s.addComment({ taskId, author: "verifier", kind: "review-note", once: true, content: `${SLOT} su 3400` });
    s.addComment({ taskId, author: "verifier", kind: "review-note", once: true, content: `${SLOT} su 3401` });
    expect(note()).toHaveLength(2);
  });
});
