/**
 * La regola dell'anteprima (PREVIEW_RULE) deve vivere nell'envelope dell'agente,
 * non nel thread di chi rivede.
 *
 * ── Prima (cbbaf0b6) ────────────────────────────────────────────────────────
 * `promoteReviewPreview` scriveva a ogni ingresso in review senza allegati un
 * paragrafo di cinque righe («Consegna SENZA anteprima…») nel thread della card.
 * Il pubblico era sbagliato: chi rivede non puo' allegare niente.
 *
 * ── Dopo ────────────────────────────────────────────────────────────────────
 * `PREVIEW_RULE` (shared/board.ts) sta in `buildKickoff` e `buildResume`:
 * l'agente legge le istruzioni PRIMA di consegnare, non a consegna fatta.
 * Il thread della card riceve al piu' una riga `kind:'service'` (ripiegata nel
 * drawer) quando c'e' un allegato scartato per forma.
 *
 * I due test qui SCANSIONANO IL SORGENTE (come molti altri gate di questo repo)
 * invece di istanziare il servizio: e' la forma piu' diretta per dire
 * «PREVIEW_RULE e' referenziata QUI e il paragrafo NON e' piu' in quel file».
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");

function src(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

describe("PREVIEW_RULE nell'envelope dell'agente", () => {
  test("buildKickoff in task-dispatcher.ts referenzia PREVIEW_RULE", () => {
    const dispatcher = src("server/services/task-dispatcher.ts");
    // La costante deve essere USATA dentro buildKickoff, non solo importata.
    // Il modo piu' diretto e' cercare il letterale subito dopo l'import check.
    expect(dispatcher).toContain("import { CODE_GATES_RULE");
    expect(dispatcher).toContain("PREVIEW_RULE");
    // Verifica che appaia all'interno della funzione buildKickoff (tra la firma
    // e la chiusura della funzione successiva), non solo nell'import.
    const kickoffStart = dispatcher.indexOf("function buildKickoff(");
    const kickoffEnd = dispatcher.indexOf("\n  function ", kickoffStart + 1);
    const kickoffBody = dispatcher.slice(kickoffStart, kickoffEnd > kickoffStart ? kickoffEnd : undefined);
    expect(kickoffBody).toContain("PREVIEW_RULE");
  });

  test("buildResume in task-dispatcher.ts referenzia PREVIEW_RULE", () => {
    const dispatcher = src("server/services/task-dispatcher.ts");
    const resumeStart = dispatcher.indexOf("function buildResume(");
    const resumeEnd = dispatcher.indexOf("\n  function ", resumeStart + 1);
    const resumeBody = dispatcher.slice(resumeStart, resumeEnd > resumeStart ? resumeEnd : undefined);
    expect(resumeBody).toContain("PREVIEW_RULE");
  });

  test("promoteReviewPreview non scrive piu' il paragrafo operativo nel thread", () => {
    const tasks = src("server/services/tasks.ts");
    // Cerca il corpo di promoteReviewPreview tra la sua firma e la funzione
    // successiva.
    const fnStart = tasks.indexOf("function promoteReviewPreview(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = tasks.indexOf("\n  function ", fnStart + 1);
    const fnBody = tasks.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);
    // Il testo operativo «Consegna SENZA anteprima» non deve piu' comparire
    // come stringa scritta nel thread.
    expect(fnBody).not.toContain("Consegna SENZA anteprima");
    // Stesso controllo per la forma piu' corta (anche cambiando maiuscole).
    expect(fnBody.toLowerCase()).not.toContain("senza anteprima");
  });
});
