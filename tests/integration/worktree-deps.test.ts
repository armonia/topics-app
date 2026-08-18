/**
 * UN WORKTREE NUOVO PUO' MISURARSI DA SOLO.
 *
 * ── Il guasto ───────────────────────────────────────────────────────────────
 * `git worktree add` copia i file TRACCIATI, e `client/node_modules` non lo e':
 * un worktree di dispatch nasce senza. Li' `eslint` e `tsc` non partono, quindi
 * DUE dei cinque cancelli di review non misurano niente. Misurato il 18/08
 * prima della correzione: 95 worktree su 103 erano cosi', cioe' quasi ogni card
 * dispacciata veniva giudicata su meta' della barra — e fino a stasera quel
 * silenzio veniva anche letto come «checks rossi».
 *
 * ── Perche' installare e non collegare ──────────────────────────────────────
 * Un symlink alle dipendenze del checkout principale sembra gratis, ma un `bun
 * install` dentro il worktree scriverebbe in quelle VERE, e un ramo che cambia
 * `client/package.json` userebbe le sbagliate in silenzio.
 *
 * ── E il costo non e' quello che dice `du` ──────────────────────────────────
 * `du` riporta ~400 MB per worktree; e' la stima che mi aveva fatto scartare
 * questa strada, ed era sbagliata. Misurato con `df` prima e dopo
 * un'installazione vera: 7 MB e 0,8 secondi. Bun clona dalla sua cache globale e
 * APFS condivide i blocchi, quindi `du` conta file che sul disco non esistono
 * due volte.
 *
 * ── Cosa sorveglia questo test ──────────────────────────────────────────────
 * Non l'installazione (e' `bun` e funziona), ma il CABLAGGIO: che la creazione
 * la chiami, che sia best-effort, e che non parta dove non serve. Il resto e'
 * lettura del sorgente per la stessa ragione degli altri cancelli di questo
 * tipo: montare un worktree vero in un test costa secondi e una cartella.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(import.meta.dir, "../../server/services/worktree-manager.ts"), "utf8");

/** Il corpo di `installClientDeps`, fino alla sua chiusura. */
function corpo(): string {
  const i = SRC.indexOf("async function installClientDeps(");
  expect(i, "installClientDeps e' cambiata di nome: aggiorna questo test").toBeGreaterThan(0);
  const fine = SRC.indexOf("\n  }", i);
  expect(fine).toBeGreaterThan(i);
  return SRC.slice(i, fine);
}

describe("le dipendenze del client arrivano col worktree", () => {
  test("il corpo si trova (guardia contro un verde a vuoto)", () => {
    expect(corpo().length).toBeGreaterThan(200);
  });

  test("la creazione la CHIAMA: un worktree che nasce cieco e' il difetto", () => {
    const creazione = SRC.slice(SRC.indexOf("async function materialiseOnDisk"));
    expect(creazione.slice(0, 2600)).toContain("await installClientDeps(absPath)");
  });

  test("installa davvero, non collega: niente symlink alle dipendenze di main", () => {
    // Un `bun install` dentro un worktree symlinkato scriverebbe nel checkout
    // principale. Se un giorno qualcuno prova la scorciatoia, questo caso lo
    // ferma prima che il danno diventi «dipendenze sbagliate, in silenzio».
    expect(corpo()).toContain('"bun", "install"');
    expect(corpo()).not.toContain("symlink");
  });

  test("`--frozen-lockfile`: il worktree usa il lockfile del SUO ramo", () => {
    // Senza, un ramo che cambia le dipendenze si ritroverebbe un lockfile
    // riscritto sotto i piedi, e il diff della card porterebbe roba che
    // l'agente non ha deciso.
    expect(corpo()).toContain("--frozen-lockfile");
  });

  test("best-effort: un install fallito NON impedisce la nascita del worktree", () => {
    // L'agente puo' lavorare lo stesso, e i cancelli che non partono adesso lo
    // DICONO (uscita 97) invece di andare rossi. Un throw qui trasformerebbe un
    // degrado onesto in una card che non nasce.
    expect(corpo()).toContain("catch");
    expect(corpo()).not.toContain("throw");
  });

  test("non parte dove non c'e' un client: non ogni progetto ne ha uno", () => {
    expect(corpo()).toContain('existsSync(join(clientDir, "package.json"))');
  });
});
