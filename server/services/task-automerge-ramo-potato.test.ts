import { describe, test, expect } from "bun:test";
import { createTaskAutoMerge } from "./task-automerge";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gitEnv } from "../../tests/setup/bun-test-preload";

/**
 * IL RAMO NON C'E' PIU', MA IL LAVORO E' IN MAIN.
 *
 * IL CASO VERO, misurato il 2026-08-20 sulla card `14a188b6` («Il dispatcher
 * ripete lo stesso sollecito nella chat del task»). Il land ha rifiutato con
 * «branch 'topics/crested-iguana' non trovato o non confrontabile con main», e
 * il rifiuto era formalmente corretto: quel ramo non esiste piu'. Ma il lavoro
 * era su main dal giorno prima — commit `654f99501`, verificato con
 * `git merge-base --is-ancestor`.
 *
 * Il land HA gia' due prove per questo caso, e sono buone:
 *   1. il commit di CONSEGNA (`delivery.commit`) e' antenato di main;
 *   2. esiste su main un MERGE che nomina la card (quello che scrive il land).
 *
 * Nessuna delle due vedeva questo caso: la card non aveva sha di consegna, e il
 * lavoro era atterrato con un commit DIRETTO su main — nessun merge di land da
 * cercare. Cioe' esattamente cio' che succede quando qualcuno fonde a mano, o
 * quando il ramo viene potato dopo una fusione fatta fuori dal land.
 *
 * L'esito era il peggiore possibile: «⚠️ Land NON riuscito», la card rispedita
 * in review, e un umano che va a cercare un ramo che non esiste per capire se
 * il lavoro c'e'. Il commento nel codice lo dice gia' di un caso gemello:
 * «riaprire una card chiusa e' il danno peggiore che questo codice possa fare».
 *
 * LA TERZA PROVA e' il TITOLO della card fra i soggetti dei commit di main. Non
 * indovina: chiede una corrispondenza ESATTA del soggetto, che e' cio' che un
 * agente scrive quando committa il lavoro di una card.
 */

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  return new TextDecoder().decode(r.stdout).trim();
}

function commit(repo: string, file: string, body: string, msg: string): string {
  writeFileSync(join(repo, file), body);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", msg);
  return git(repo, "rev-parse", "HEAD");
}

/** Un repo dove il lavoro della card e' su main con un commit DIRETTO, e il suo
 *  ramo e' stato potato: la forma esatta del caso reale. */
function repoConRamoPotato(titolo: string): string {
  const repo = mkdtempSync(join(tmpdir(), "land-ramo-potato-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
  commit(repo, "base.txt", "base\n", "base");
  // Il lavoro della card, atterrato con un commit diretto: nessun merge di
  // land, nessuno sha di consegna registrato.
  commit(repo, "lavoro.txt", "fatto\n", titolo);
  return repo;
}

const land = (repo: string, branch: string) =>
  createTaskAutoMerge({
    resolveTaskMerge: () => ({ repoPath: repo, branch, defaultBranch: "main" }),
  });

describe("ramo potato, lavoro gia' su main", () => {
  const TITOLO = "Il dispatcher ripete lo stesso sollecito nella chat del task";

  test("riconosce il lavoro dal TITOLO e non accusa: «nothing», non «branch-missing»", async () => {
    const repo = repoConRamoPotato(TITOLO);
    try {
      const res = await land(repo, "topics/mai-esistito").tryMerge("t-1", TITOLO);
      // «nothing» = non c'e' niente da atterrare, ed e' la verita': il lavoro
      // c'e' gia'. «skipped» avrebbe rispedito la card in review con un avviso.
      expect(res.status).toBe("nothing");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("un titolo che NON compare su main resta un rifiuto: la terza prova non indovina", async () => {
    // Il rischio della regola nuova e' l'opposto di quello che ripara: chiudere
    // una card il cui lavoro non c'e'. Il confronto e' sul soggetto ESATTO.
    const repo = repoConRamoPotato("Tutt'altro lavoro, di un'altra card");
    try {
      const res = await land(repo, "topics/mai-esistito").tryMerge("t-2", TITOLO);
      expect(res.status).toBe("skipped");
      if (res.status !== "skipped") return;
      expect(res.code).toBe("branch-missing");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("un titolo VUOTO non fa passare tutto: senza titolo non c'e' prova", async () => {
    // `git log --grep=` con una stringa vuota combacia con QUALSIASI commit: la
    // regola diventerebbe «chiudi sempre», che e' il difetto peggiore
    // dell'insieme. Il caso limite vale la riga di codice che lo esclude.
    const repo = repoConRamoPotato(TITOLO);
    try {
      const res = await land(repo, "topics/mai-esistito").tryMerge("t-3", "   ");
      expect(res.status).toBe("skipped");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("il titolo e' cercato ALLA LETTERA, non come espressione regolare", async () => {
    // Un titolo con `(`, `[` o `.` e' normale su questa board. Se la ricerca
    // fosse una regex, un titolo con parentesi sbilanciate farebbe esplodere
    // git — e il land direbbe «non riuscito» per un motivo che non c'entra.
    const strano = "Fix (parziale) del [dispatcher]: 3.0 -> 3.1";
    const repo = repoConRamoPotato(strano);
    try {
      const res = await land(repo, "topics/mai-esistito").tryMerge("t-4", strano);
      expect(res.status).toBe("nothing");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * LA CARD SQUASHATA: consegna nota, ramo potato, contenuto su main.
 *
 * La forma piu' comune di atterraggio fuori dal land e' lo SQUASH: il lavoro
 * entra in main come un commit solo, con un messaggio riscritto. Il commit di
 * consegna non e' quindi antenato di main (sha diverso), il suo titolo non
 * compare (messaggio riscritto), e non c'e' merge di land da cercare.
 *
 * Il repo ha gia' la risposta a questa domanda — `commitStatusFromRepo` in
 * `branch-status.ts` guarda anche il CONTENUTO: se ogni file toccato dal commit
 * e' identico su main, il lavoro c'e'. La usano l'audit degli atterraggi, il
 * cancello del dispatch e il GC dei worktree.
 *
 * Il land no: usa `commitIsIn`, che e' la sola discendenza. Il commento nel
 * codice dichiara che «il cancello del dispatch decide sulla STESSA
 * affermazione» — e non e' vero, il dispatch ne guarda tre. Questo caso misura
 * quella divergenza invece di dedurla.
 */
describe("card squashata: il contenuto e' su main ma lo sha no", () => {
  test("il land se ne accorge invece di accusare un ramo che non c'e'", async () => {
    const repo = mkdtempSync(join(tmpdir(), "land-squash-"));
    try {
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "user.email", "t@t.t");
      git(repo, "config", "user.name", "t");
      commit(repo, "base.txt", "base\n", "base");

      // Il lavoro della card, su un ramo suo.
      git(repo, "switch", "-q", "-c", "topics/squashata");
      const consegna = commit(repo, "lavoro.txt", "il contenuto\n", "titolo originale della card");

      // Su main entra lo STESSO contenuto, con un messaggio riscritto: e' cio'
      // che fa uno squash. Sha diverso, titolo diverso.
      git(repo, "switch", "-q", "main");
      commit(repo, "lavoro.txt", "il contenuto\n", "chore: squash di roba varia");

      // E il ramo viene potato, come succede dopo.
      git(repo, "branch", "-D", "topics/squashata");

      const res = await land(repo, "topics/squashata").tryMerge(
        "t-squash", "titolo originale della card", { branch: "topics/squashata", commit: consegna },
      );
      // Il contenuto c'e': non c'e' niente da atterrare, e la card si chiude.
      expect(res.status).toBe("nothing");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("contenuto DIVERSO su main: resta un rifiuto", async () => {
    // Il rovescio: stesso file toccato, contenuto diverso. Il lavoro NON c'e',
    // e chiudere la card perderebbe il cambiamento.
    const repo = mkdtempSync(join(tmpdir(), "land-squash-no-"));
    try {
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "user.email", "t@t.t");
      git(repo, "config", "user.name", "t");
      commit(repo, "base.txt", "base\n", "base");
      git(repo, "switch", "-q", "-c", "topics/squashata");
      const consegna = commit(repo, "lavoro.txt", "il contenuto della card\n", "titolo originale della card");
      git(repo, "switch", "-q", "main");
      commit(repo, "lavoro.txt", "TUTT'ALTRO contenuto\n", "chore: altro lavoro sullo stesso file");
      git(repo, "branch", "-D", "topics/squashata");

      const res = await land(repo, "topics/squashata").tryMerge(
        "t-squash-no", "titolo originale della card", { branch: "topics/squashata", commit: consegna },
      );
      expect(res.status).toBe("skipped");
      if (res.status !== "skipped") return;
      expect(res.code).toBe("branch-missing");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);
});
