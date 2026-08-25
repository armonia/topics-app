/**
 * La regola che autorizza a cancellare, provata su repo veri e minuscoli.
 *
 * Non è un test di comodo: è l'unico posto dove si può sbagliare in modo caro.
 * Il caso che conta è il TERZO — il ramo squash-landato, che `merge-base` chiama
 * vivo per sempre e che il criterio per contenuto riconosce. Se quel caso si
 * rompe, il mucchio di rami non cala; se si rompe il QUARTO (lavoro vero letto
 * come landato), si cancella qualcosa che serviva.
  * @covers LAND-08
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  landedVerdict,
  filterUniqueSourceFiles,
  makeMainIndex,
  isSafeToDelete,
  isDisposableBranchName,
} from "./landed-lib";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Un repo con main e un commit iniziale. Il chiamante lo cancella. */
function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "landed-test-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "uno\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

function commit(repo: string, file: string, body: string, msg: string): void {
  writeFileSync(join(repo, file), body);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", msg);
}

describe("landedVerdict", () => {
  test("un ramo il cui tip è su main è 'antenato'", () => {
    const repo = newRepo();
    try {
      git(repo, "branch", "vecchio");
      expect(landedVerdict(repo, "vecchio")).toBe("antenato");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("un ramo squash-landato è 'identico' anche se non è antenato di main", () => {
    const repo = newRepo();
    try {
      git(repo, "checkout", "-qb", "lavoro");
      commit(repo, "b.txt", "il lavoro\n", "lavoro");
      git(repo, "checkout", "-q", "main");
      // La consegna: stesso CONTENUTO, commit diverso. È lo squash landing.
      commit(repo, "b.txt", "il lavoro\n", "squash del lavoro");

      // La discendenza dice di no...
      expect(() => git(repo, "merge-base", "--is-ancestor", "lavoro", "main")).toThrow();
      // ...il contenuto dice di sì, ed è quello che conta.
      expect(landedVerdict(repo, "lavoro")).toBe("identico");
      expect(isSafeToDelete(landedVerdict(repo, "lavoro"))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("un ramo con lavoro suo resta 'vivo'", () => {
    const repo = newRepo();
    try {
      git(repo, "checkout", "-qb", "mio");
      commit(repo, "c.txt", "roba che main non ha\n", "roba mia");
      git(repo, "checkout", "-q", "main");
      expect(landedVerdict(repo, "mio")).toBe("vivo");
      expect(isSafeToDelete(landedVerdict(repo, "mio"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("un ramo dietro main, che non ha toccato niente di suo, è 'identico'", () => {
    const repo = newRepo();
    try {
      git(repo, "branch", "fermo");
      commit(repo, "a.txt", "due\n", "main va avanti");
      // `fermo` differisce da main, ma il diff è di MAIN, non suo.
      expect(landedVerdict(repo, "fermo")).toBe("antenato");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("il diff già presente su main, con main che ci ha scritto sopra, è 'riassorbito'", () => {
    const repo = newRepo();
    try {
      writeFileSync(join(repo, "d.txt"), "riga1\nriga2\nriga3\nriga4\nriga5\nriga6\nriga7\nriga8\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "base");
      git(repo, "checkout", "-qb", "tocco");
      commit(repo, "d.txt", "riga1\nriga2\nMIA\nriga4\nriga5\nriga6\nriga7\nriga8\n", "la mia riga");
      git(repo, "checkout", "-q", "main");
      // main ha la MIA riga più una sua, in fondo: i file non sono identici.
      commit(repo, "d.txt", "riga1\nriga2\nMIA\nriga4\nriga5\nriga6\nriga7\nriga8\nDI MAIN\n", "landing + altro");

      const index = makeMainIndex(repo);
      expect(index).not.toBeNull();
      const v = landedVerdict(repo, "tocco", "main", index);
      expect(v).toBe("riassorbito");
      // Riassorbito NON autorizza la cancellazione: la chiama l'umano.
      expect(isSafeToDelete(v)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("senza indice di main il caso 'riassorbito' non viene inventato", () => {
    const repo = newRepo();
    try {
      git(repo, "checkout", "-qb", "tocco");
      commit(repo, "a.txt", "uno\ndue\n", "aggiungo");
      git(repo, "checkout", "-q", "main");
      commit(repo, "a.txt", "uno\ndue\ntre\n", "aggiungo anch'io");
      expect(landedVerdict(repo, "tocco")).toBe("vivo");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("isDisposableBranchName", () => {
  test("i rami che genera la macchina sono usa-e-getta", () => {
    for (const b of ["topics/arctic-harbor", "task/qualcosa", "worktree-wf_abc-1", "wf_abc-2"]) {
      expect(isDisposableBranchName(b)).toBe(true);
    }
  });

  test("un ramo battezzato a mano non si cancella da solo, anche se è dentro main", () => {
    // Il caso vero: `electron-archive` è antenato di main, quindi "cancellabile"
    // per contenuto — ma il README lo cita per nome come via di recupero.
    for (const b of ["electron-archive", "salvataggio/orange-rapids-pre-billing", "fix/keyboard-sensor", "main"]) {
      expect(isDisposableBranchName(b)).toBe(false);
    }
  });
});

describe("filterUniqueSourceFiles", () => {
  test("toglie lock, manifest e output di build, tiene il sorgente", () => {
    expect(
      filterUniqueSourceFiles([
        "bun.lock",
        "package.json",
        "public/bundle.js",
        "client/src/App.tsx",
        "desktop-tauri/src-tauri/Cargo.lock",
        "server/routes/tasks.ts",
        "",
      ]),
    ).toEqual(["client/src/App.tsx", "server/routes/tasks.ts"]);
  });
});
