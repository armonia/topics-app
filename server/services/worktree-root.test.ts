/**
 * LA RADICE DEI WORKTREE SEGUE `TOPICS_HOME`.
 *
 * Il guasto che lo fa nascere: `worktree-manager.ts` calcolava la radice come
 * `join(homedir(), ".topics", "worktrees")`, cablata. `TOPICS_HOME` esiste
 * apposta per dare a un server una casa tutta sua — lo imposta il server di
 * test — e quella riga lo scavalcava.
 *
 * Risultato misurato il 19/08/2026 nella casa VERA: 55 cartelle di progetti
 * `e2e-naming-…`, `e2e-rename-…`, `e2e-archive-…`. Il database dei test era
 * confinato, i loro checkout no, e nessun registro li conosceva — quindi la
 * potatura non poteva nemmeno vederli.
 *
 * @covers WORKTREE-06
 */
import { describe, test, expect } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { worktreeRootDir } from "./worktree-manager";

describe("radice dei worktree", () => {
  test("con TOPICS_HOME, i worktree stanno DENTRO quella casa", () => {
    const casa = "/tmp/una-casa-di-prova";  // allow-shared-tmp: e' un DATO, non una cartella — worktreeRootDir e' puro calcolo su stringhe e non tocca il disco
    expect(worktreeRootDir({ TOPICS_HOME: casa })).toBe(join(casa, "worktrees"));
  });

  test("senza TOPICS_HOME si ricade sulla casa dell'utente (comportamento di sempre)", () => {
    expect(worktreeRootDir({})).toBe(join(homedir(), ".topics", "worktrees"));
  });

  test("TOPICS_WORKTREES_DIR resta l'override esplicito e vince su tutto", () => {
    expect(worktreeRootDir({ TOPICS_HOME: "/tmp/casa", TOPICS_WORKTREES_DIR: "/tmp/altrove" }))  // allow-shared-tmp: e' un DATO, non una cartella — worktreeRootDir e' puro calcolo su stringhe e non tocca il disco
      .toBe("/tmp/altrove");  // allow-shared-tmp: e' un DATO, non una cartella — worktreeRootDir e' puro calcolo su stringhe e non tocca il disco
  });

  test("la casa di un server e quella dei suoi worktree non possono divergere", () => {
    // È l'invariante, non un terzo caso: qualunque casa si scelga, i worktree
    // ci stanno sotto. Un ripiego cablato la romperebbe in silenzio.
    for (const casa of ["/tmp/a", "/tmp/b/c", "/var/folders/x/.topics-home"]) {  // allow-shared-tmp: e' un DATO, non una cartella — worktreeRootDir e' puro calcolo su stringhe e non tocca il disco
      expect(worktreeRootDir({ TOPICS_HOME: casa }).startsWith(casa + "/")).toBe(true);
    }
  });
});
