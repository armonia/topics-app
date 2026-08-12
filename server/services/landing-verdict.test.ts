import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  classifyBranchLanding,
  indiceRigheMain,
  isRigaDistintiva,
  RIGA_DISTINTIVA_MIN,
} from "./landing-verdict";

/**
 * Ogni caso monta un repo git vero: sono una decina di `spawnSync` a testa, e i
 * 5 secondi di bun li coprono solo a macchina scarica. Quando la suite gira
 * insieme a un build o a un E2E ogni spawn scivola, l'ultimo caso sfora e il
 * rosso non dice niente sul codice sotto. Il limite vero qui è la durata degli
 * spawn, non la logica, quindi il tetto sta largo.
 */
const TEMPO_GIT = 30_000;

const creati: string[] = [];
afterAll(() => {
  for (const d of creati) rmSync(d, { recursive: true, force: true });
});

/**
 * Le date sono FISSATE, non prese dall'orologio: la supersessione è una domanda
 * sull'ORDINE («main ha rifatto quel file dopo?»), e due commit fatti nello
 * stesso secondo la renderebbero una monetina. Con un giorno di distanza il
 * test dice quello che vuole dire anche a macchina lenta.
 */
function git(cwd: string, args: string[], quando?: string): string {
  const env = quando
    ? { ...process.env, GIT_AUTHOR_DATE: quando, GIT_COMMITTER_DATE: quando }
    : process.env;
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env });
  return new TextDecoder().decode(r.stdout).trim();
}

function scrivi(repo: string, file: string, testo: string): void {
  const p = join(repo, file);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, testo);
}

function commit(repo: string, messaggio: string, quando: string): void {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", messaggio], quando);
}

function nuovoRepo(nome: string): string {
  const repo = mkdtempSync(join(tmpdir(), `lverd-${nome}-`));
  creati.push(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.t"]);
  git(repo, ["config", "user.name", "t"]);
  scrivi(repo, "README.md", "base\n");
  commit(repo, "base", "2026-07-01T10:00:00+02:00");
  return repo;
}

/** Righe abbastanza lunghe da valere come impronta del ramo. */
function impronte(prefisso: string, quante: number): string {
  return Array.from(
    { length: quante },
    (_, i) => `export const ${prefisso}Riga${i} = "impronta lunga e irripetibile numero ${i}";`,
  ).join("\n") + "\n";
}

describe("isRigaDistintiva", () => {
  test("prende le righe lunghe con qualcosa dentro, scarta corte e punteggiatura", () => {
    expect(isRigaDistintiva(`const x = "${"a".repeat(RIGA_DISTINTIVA_MIN)}";`)).toBe(true);
    expect(isRigaDistintiva("  });")).toBe(false);
    expect(isRigaDistintiva("=".repeat(RIGA_DISTINTIVA_MIN + 10))).toBe(false);
  }, TEMPO_GIT);
});

describe("indiceRigheMain", () => {
  test("indicizza le righe lunghe di main e ignora le corte", async () => {
    const repo = nuovoRepo("indice");
    scrivi(repo, "src/a.ts", impronte("alfa", 2) + "let x = 1;\n");
    commit(repo, "roba", "2026-07-02T10:00:00+02:00");

    const indice = await indiceRigheMain(repo);
    expect(indice.has(`export const alfaRiga0 = "impronta lunga e irripetibile numero 0";`)).toBe(true);
    expect(indice.has("let x = 1;")).toBe(false);
  }, TEMPO_GIT);
});

describe("classifyBranchLanding", () => {
  test("DENTRO quando ogni file toccato è identico su main (squash-land)", async () => {
    const repo = nuovoRepo("identico");
    scrivi(repo, "src/a.ts", "vecchio\n");
    commit(repo, "prima", "2026-07-02T10:00:00+02:00");
    git(repo, ["checkout", "-q", "-b", "topics/ramo"]);
    scrivi(repo, "src/a.ts", impronte("uno", 4));
    commit(repo, "lavoro del ramo", "2026-07-03T10:00:00+02:00");
    // Su main lo stesso contenuto, con un altro sha: è quello che fa lo squash.
    git(repo, ["checkout", "-q", "main"]);
    scrivi(repo, "src/a.ts", impronte("uno", 4));
    commit(repo, "rimesso a mano", "2026-07-04T10:00:00+02:00");

    const v = await classifyBranchLanding(repo, "topics/ramo");
    expect(v.esito).toBe("dentro");
    expect(v.motivo).toContain("identico su main");
  }, TEMPO_GIT);

  test("DENTRO per contenuto quando le righe del ramo sono su main dentro un file EVOLUTO", async () => {
    const repo = nuovoRepo("righe");
    scrivi(repo, "src/a.ts", "vecchio\n");
    commit(repo, "prima", "2026-07-02T10:00:00+02:00");
    git(repo, ["checkout", "-q", "-b", "topics/ramo"]);
    scrivi(repo, "src/a.ts", impronte("due", 5));
    commit(repo, "lavoro del ramo", "2026-07-03T10:00:00+02:00");
    // Il lavoro atterra e POI il file evolve: il confronto byte a byte fallirebbe.
    git(repo, ["checkout", "-q", "main"]);
    scrivi(repo, "src/a.ts", impronte("due", 5) + "\n// rifinitura successiva\nlet y = 2;\n");
    commit(repo, "atterrato e rifinito", "2026-07-05T10:00:00+02:00");

    const v = await classifyBranchLanding(repo, "topics/ramo");
    expect(v.esito).toBe("dentro");
    expect(v.righe).toEqual({ cercate: 5, presenti: 5 });
  }, TEMPO_GIT);

  test("DENTRO anche se la riga è finita in un ALTRO file su main", async () => {
    const repo = nuovoRepo("spostato");
    scrivi(repo, "src/a.ts", "vecchio\n");
    commit(repo, "prima", "2026-07-02T10:00:00+02:00");
    git(repo, ["checkout", "-q", "-b", "topics/ramo"]);
    scrivi(repo, "src/a.ts", impronte("tre", 4));
    commit(repo, "lavoro del ramo", "2026-07-03T10:00:00+02:00");
    git(repo, ["checkout", "-q", "main"]);
    scrivi(repo, "src/estratto.ts", impronte("tre", 4));
    commit(repo, "atterrato in un componente estratto", "2026-07-05T10:00:00+02:00");

    const v = await classifyBranchLanding(repo, "topics/ramo");
    expect(v.esito).toBe("dentro");
    expect(v.righe.presenti).toBe(4);
  }, TEMPO_GIT);

  test("SUPERATO col commit e la data di chi lo ha superato", async () => {
    const repo = nuovoRepo("superato");
    scrivi(repo, "src/outline.ts", "prima versione\n");
    commit(repo, "prima", "2026-07-02T10:00:00+02:00");
    git(repo, ["checkout", "-q", "-b", "topics/ramo"]);
    scrivi(repo, "src/outline.ts", impronte("osservatore", 8));
    commit(repo, "outline con IntersectionObserver", "2026-07-19T23:00:00+02:00");
    // Tre giorni dopo, su main, un altro risolve la stessa cosa in un altro modo.
    git(repo, ["checkout", "-q", "main"]);
    scrivi(repo, "src/outline.ts", impronte("pallini", 3));
    commit(repo, "navigatore a pallini", "2026-07-22T11:56:00+02:00");

    const v = await classifyBranchLanding(repo, "topics/ramo");
    expect(v.esito).toBe("superato");
    expect(v.superatoDa?.subject).toBe("navigatore a pallini");
    expect(v.superatoDa?.data.slice(0, 10)).toBe("2026-07-22");
    expect(v.commitDopo).toBe(1);
  }, TEMPO_GIT);

  test("fra i candidati vince quello che tocca PIÙ file del ramo, non il più recente", async () => {
    const repo = nuovoRepo("tiebreak");
    for (const f of ["src/a.ts", "src/b.ts", "src/c.ts"]) scrivi(repo, f, "prima\n");
    commit(repo, "prima", "2026-07-02T10:00:00+02:00");
    git(repo, ["checkout", "-q", "-b", "topics/ramo"]);
    for (const f of ["src/a.ts", "src/b.ts", "src/c.ts"]) scrivi(repo, f, impronte("ramo", 4));
    commit(repo, "lavoro del ramo", "2026-07-19T23:00:00+02:00");
    git(repo, ["checkout", "-q", "main"]);
    scrivi(repo, "src/a.ts", impronte("altro", 3));
    scrivi(repo, "src/b.ts", impronte("altro", 3));
    commit(repo, "il lavoro che ha preso il posto del ramo", "2026-07-22T10:00:00+02:00");
    scrivi(repo, "src/c.ts", impronte("rifinitura", 3));
    commit(repo, "rifinitura di passaggio", "2026-07-23T10:00:00+02:00");

    const v = await classifyBranchLanding(repo, "topics/ramo");
    expect(v.esito).toBe("superato");
    expect(v.superatoDa?.subject).toBe("il lavoro che ha preso il posto del ramo");
    expect(v.superatoDa?.fileToccati).toBe(2);
  }, TEMPO_GIT);

  test("FUORI quando main non ha né le righe né ha rifatto quei file dopo", async () => {
    const repo = nuovoRepo("fuori");
    scrivi(repo, "src/a.ts", "prima\n");
    // Main tocca il file PRIMA del ramo: non è supersessione, è solo il passato.
    commit(repo, "tocco di main, ma prima", "2026-07-19T20:34:00+02:00");
    git(repo, ["checkout", "-q", "-b", "topics/ramo"]);
    scrivi(repo, "src/a.ts", impronte("debito", 6));
    commit(repo, "lavoro mai atterrato", "2026-07-19T21:29:00+02:00");

    const v = await classifyBranchLanding(repo, "topics/ramo");
    expect(v.esito).toBe("fuori");
    expect(v.superatoDa).toBeNull();
    expect(v.righe).toEqual({ cercate: 6, presenti: 0 });
  }, TEMPO_GIT);

  test("FUORI, non SUPERATO, se il ramo AGGIUNGE in fondo a un file che main ha toccato altrove", async () => {
    // Il falso positivo di `epic-chimera`, 12/08: 23 righe in coda a
    // CONTRIBUTING.md, main quel file l'ha toccato due volte dopo per tutt'altro.
    // Le sole date lo assolvevano; quella sezione su main non c'è ancora.
    const repo = nuovoRepo("coda");
    scrivi(repo, "docs/guida.md", `# Guida\n\n${impronte("vecchio", 6)}\n## Coda\n\nfine\n`);
    commit(repo, "prima", "2026-07-02T10:00:00+02:00");
    git(repo, ["checkout", "-q", "-b", "topics/ramo"]);
    scrivi(repo, "docs/guida.md", `# Guida\n\n${impronte("vecchio", 6)}\n## Coda\n\nfine\n\n## Sezione nuova\n\n${impronte("aggiunta", 5)}`);
    commit(repo, "una sezione in fondo", "2026-07-19T21:00:00+02:00");
    // Main tocca lo stesso file dopo, ma in cima: la sezione nuova non la scrive.
    git(repo, ["checkout", "-q", "main"]);
    scrivi(repo, "docs/guida.md", `# Guida rivista\n\n${impronte("vecchio", 6)}\n## Coda\n\nfine\n`);
    commit(repo, "ritoccato il titolo", "2026-07-22T10:00:00+02:00");

    const v = await classifyBranchLanding(repo, "topics/ramo");
    expect(v.esito).toBe("fuori");
    expect(v.superatoDa).toBeNull();
    expect(v.motivo).toContain("si fonde ancora pulito");
  }, TEMPO_GIT);

  test("FUORI, non SUPERATO, se un file del ramo su main non esiste proprio", async () => {
    const repo = nuovoRepo("assente");
    scrivi(repo, "src/a.ts", "prima\n");
    commit(repo, "prima", "2026-07-02T10:00:00+02:00");
    git(repo, ["checkout", "-q", "-b", "topics/ramo"]);
    scrivi(repo, "src/a.ts", impronte("uno", 4));
    scrivi(repo, "docs/nuovo.md", impronte("due", 4));
    commit(repo, "lavoro del ramo", "2026-07-19T21:00:00+02:00");
    // Main rifà il file condiviso, ma quello NUOVO non ce l'ha nessuno.
    git(repo, ["checkout", "-q", "main"]);
    scrivi(repo, "src/a.ts", impronte("altro", 4));
    commit(repo, "main va avanti per conto suo", "2026-07-22T10:00:00+02:00");

    const v = await classifyBranchLanding(repo, "topics/ramo");
    expect(v.esito).toBe("fuori");
    expect(v.assentiSuMain).toEqual(["docs/nuovo.md"]);
    expect(v.motivo).toContain("non esistono");
  }, TEMPO_GIT);

  test("NON DECIDIBILE quando non c'è nessuna riga lunga da cercare", async () => {
    const repo = nuovoRepo("indeciso");
    scrivi(repo, "src/a.ts", "let x = 1;\n");
    commit(repo, "prima", "2026-07-02T10:00:00+02:00");
    git(repo, ["checkout", "-q", "-b", "topics/ramo"]);
    scrivi(repo, "src/a.ts", "let x = 2;\nlet y = 3;\n");
    commit(repo, "due righe corte", "2026-07-03T10:00:00+02:00");

    const v = await classifyBranchLanding(repo, "topics/ramo");
    expect(v.esito).toBe("non-decidibile");
    expect(v.motivo).toContain("nessuna riga distintiva");
  }, TEMPO_GIT);

  test("DENTRO quando il ramo tocca solo file generati", async () => {
    const repo = nuovoRepo("rumore");
    scrivi(repo, "bun.lock", "prima\n");
    commit(repo, "prima", "2026-07-02T10:00:00+02:00");
    git(repo, ["checkout", "-q", "-b", "topics/ramo"]);
    scrivi(repo, "bun.lock", impronte("lock", 5));
    commit(repo, "solo il lockfile", "2026-07-03T10:00:00+02:00");

    const v = await classifyBranchLanding(repo, "topics/ramo");
    expect(v.esito).toBe("dentro");
    expect(v.motivo).toContain("generati");
  }, TEMPO_GIT);

  test("NON DECIDIBILE, non «fuori», quando il repo non ha il ramo d'integrazione", async () => {
    const repo = nuovoRepo("senzamain");
    git(repo, ["checkout", "-q", "-b", "topics/ramo"]);
    const v = await classifyBranchLanding(repo, "topics/ramo", { mainRef: "inesistente" });
    expect(v.esito).toBe("non-decidibile");
    expect(v.motivo).toContain("inesistente");
  }, TEMPO_GIT);

  test("i commit EREDITATI da un altro ramo non contano come lavoro proprio", async () => {
    const repo = nuovoRepo("eredita");
    scrivi(repo, "src/altrui.ts", "prima\n");
    commit(repo, "prima", "2026-07-02T10:00:00+02:00");
    // Un'altra sessione ha parcheggiato il suo lavoro sul checkout condiviso.
    git(repo, ["checkout", "-q", "-b", "topics/altra-sessione"]);
    scrivi(repo, "src/altrui.ts", impronte("altrui", 6));
    commit(repo, "lavoro di un'altra card", "2026-07-03T10:00:00+02:00");
    // Il ramo nasce da lì e non aggiunge niente di suo.
    git(repo, ["checkout", "-q", "-b", "topics/ramo"]);

    const v = await classifyBranchLanding(repo, "topics/ramo");
    expect(v.esito).toBe("dentro");
    expect(v.motivo).toContain("nessun commit proprio");
  }, TEMPO_GIT);
});
