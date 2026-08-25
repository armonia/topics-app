/**
 * Le tre ancore del pannello «Modifiche», su git VERO.
 *
 * Con un runner finto si prova che il codice compone le stringhe che si è
 * deciso di comporre — cioè si prova sé stesso. Qui ogni caso costruisce il
 * guasto: un ramo che eredita i commit di un'altra sessione, un land per merge,
 * un land per cherry-pick con il ramo potato. La gamma che esce viene poi data a
 * `git diff --name-only`, e l'asserzione è sui FILE che il reviewer vedrebbe.
 *
 * @covers LAND-02
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  worktreeOwnRange,
  landedMergeRange,
  deliveryCommitRange,
  resolveTaskDiffRange,
} from "./task-diff-range";

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

async function git(cwd: string, args: string[]): Promise<string> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: ENV });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

/** I file che il pannello disegnerebbe, data la gamma risolta. */
async function filesOf(cwd: string, range: string): Promise<string[]> {
  return (await git(cwd, ["diff", "--name-only", range])).split("\n").filter(Boolean).sort();
}

async function commit(dir: string, file: string, body: string, msg: string): Promise<string> {
  writeFileSync(join(dir, file), body);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-qm", msg]);
  return git(dir, ["rev-parse", "HEAD"]);
}

describe("task-diff-range", () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "taskdiffrange-"));
    await git(dir, ["init", "-q", "-b", "main"]);
    await git(dir, ["config", "user.email", "t@t.t"]);
    await git(dir, ["config", "user.name", "t"]);
    await git(dir, ["config", "commit.gpgsign", "false"]);
    await commit(dir, "base.txt", "base\n", "base");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("il ramo che EREDITA i commit di un'altra sessione non se li intesta", async () => {
    // L'altra sessione, parcheggiata sul checkout condiviso.
    await git(dir, ["checkout", "-q", "-b", "topics/altra"]);
    await commit(dir, "roba-di-un-altro.ts", "non mia\n", "lavoro altrui");
    // La card nasce da LÌ, com'era prima di `worktree-base-ref.ts`.
    await git(dir, ["checkout", "-q", "-b", "topics/card"]);
    await commit(dir, "mio.ts", "mio\n", "lavoro della card");

    const r = await worktreeOwnRange(dir, { branch: "topics/card" });
    expect(r).not.toBeNull();
    expect(await filesOf(dir, r!.range)).toEqual(["mio.ts"]);

    // La domanda vecchia — `merge-base main HEAD` — intestava entrambi.
    const oldBase = await git(dir, ["merge-base", "main", "topics/card"]);
    expect(await filesOf(dir, oldBase)).toEqual(["mio.ts", "roba-di-un-altro.ts"]);
  });

  test("il ramo che ha INGLOBATO main non intesta a sé quello che main ha portato", async () => {
    // Da quando il land riporta main dentro un ramo vecchio da sé
    // (`task-automerge.ts`), un ramo con un merge di main è il caso NORMALE di
    // ogni card che aspetta la review più di qualche ora. Il padre del primo
    // commit della card è un punto della storia prima di quel merge: da lì il
    // pannello mostrava anche il lavoro delle altre card, sotto questo nome.
    await git(dir, ["checkout", "-q", "-b", "topics/card"]);
    await commit(dir, "mio.ts", "mio\n", "lavoro della card");
    await git(dir, ["checkout", "-q", "main"]);
    await commit(dir, "di-un-altra-card.ts", "atterrato nel frattempo\n", "main avanza");
    await git(dir, ["checkout", "-q", "topics/card"]);
    await git(dir, ["merge", "-q", "--no-edit", "main"]);

    const r = await worktreeOwnRange(dir, { branch: "topics/card" });
    expect(r).not.toBeNull();
    expect(await filesOf(dir, r!.range)).toEqual(["mio.ts"]);
  });

  test("senza commit propri resta il lavoro NON committato, e solo quello", async () => {
    await git(dir, ["checkout", "-q", "-b", "topics/altra"]);
    await commit(dir, "roba-di-un-altro.ts", "non mia\n", "lavoro altrui");
    await git(dir, ["checkout", "-q", "-b", "topics/appena-nata"]);
    writeFileSync(join(dir, "base.txt"), "base\nappena scritto\n");

    const r = await worktreeOwnRange(dir, { branch: "topics/appena-nata" });
    expect(r).not.toBeNull();
    expect(r!.live).toBe(true);
    expect(await filesOf(dir, r!.range)).toEqual(["base.txt"]);
  });

  test("la gamma viva arriva fino all'ALBERO: committato più non committato", async () => {
    await git(dir, ["checkout", "-q", "-b", "topics/card"]);
    await commit(dir, "committato.ts", "a\n", "lavoro committato");
    writeFileSync(join(dir, "base.txt"), "base\nmodifica viva\n");

    const r = await worktreeOwnRange(dir, { branch: "topics/card" });
    expect(await filesOf(dir, r!.range)).toEqual(["base.txt", "committato.ts"]);
  });

  test("un commit proprio che è la RADICE si misura dall'albero vuoto", async () => {
    const empty = mkdtempSync(join(tmpdir(), "taskdiffrange-root-"));
    try {
      await git(empty, ["init", "-q", "-b", "main"]);
      await git(empty, ["config", "user.email", "t@t.t"]);
      await git(empty, ["config", "user.name", "t"]);
      await git(empty, ["config", "commit.gpgsign", "false"]);
      // `main` esiste come ref solo dopo il primo commit: qui la card È la radice.
      await commit(empty, "primo.ts", "uno\n", "il primo commit del repo");
      const r = await worktreeOwnRange(empty, { branch: "main", mainRef: "non-esiste" });
      expect(r).toBeNull(); // senza `main` la sottrazione non è contabile

      await git(empty, ["branch", "-q", "-f", "vuoto-main", "HEAD"]);
      const r2 = await worktreeOwnRange(empty, { branch: "main", mainRef: "vuoto-main" });
      expect(r2).not.toBeNull();
      expect(await filesOf(empty, r2!.range)).toEqual([]); // stessa punta: niente di suo
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("HEAD staccato non è misurabile (nessuna gamma inventata)", async () => {
    const sha = await git(dir, ["rev-parse", "HEAD"]);
    await git(dir, ["checkout", "-q", "--detach", sha]);
    expect(await worktreeOwnRange(dir)).toBeNull();
  });

  describe("dopo il land", () => {
    let cardCommit: string;

    beforeEach(async () => {
      await git(dir, ["checkout", "-q", "-b", "topics/card"]);
      cardCommit = await commit(dir, "consegna.ts", "riga uno\nriga due\n", "la consegna della card");
      await git(dir, ["checkout", "-q", "main"]);
    });

    test("il merge del land è il riferimento durevole: sopravvive al ramo potato", async () => {
      await git(dir, ["merge", "--no-ff", "-m", "merge task T-42: il titolo della card", "topics/card"]);
      await git(dir, ["branch", "-qD", "topics/card"]); // il reap

      const r = await landedMergeRange(dir, "T-42");
      expect(r).not.toBeNull();
      expect(r!.source).toBe("landed-merge");
      expect(r!.live).toBe(false);
      expect(await filesOf(dir, r!.range)).toEqual(["consegna.ts"]);
    });

    test("il merge di un'ALTRA card non risponde per questa", async () => {
      await git(dir, ["merge", "--no-ff", "-m", "merge task T-42: il titolo della card", "topics/card"]);
      expect(await landedMergeRange(dir, "T-99")).toBeNull();
    });

    test("un commit normale che CITA l'id non viene scambiato per un atterraggio", async () => {
      await commit(dir, "nota.md", "vedi\n", "nota su merge task T-42: da rivedere");
      expect(await landedMergeRange(dir, "T-42")).toBeNull();
    });

    test("il land per cherry-pick non lascia un merge: risponde il commit di consegna", async () => {
      // Main è andato avanti mentre la card lavorava — è il caso normale, ed è
      // anche ciò che rende il pick una COPIA: con main fermo al punto di fork
      // git farebbe fast-forward e lo sha resterebbe lo stesso.
      await commit(dir, "main-avanza.txt", "altro\n", "lavoro su main");
      // Il pick RICOPIA: su main lo sha è un altro, quindi il commit consegnato
      // resta «fuori da main» e la sottrazione lo sa ancora leggere.
      await git(dir, ["cherry-pick", cardCommit]);
      await git(dir, ["branch", "-qD", "topics/card"]);

      expect(await landedMergeRange(dir, "T-42")).toBeNull();
      const r = await deliveryCommitRange(dir, { branch: "topics/card", commit: cardCommit });
      expect(r).not.toBeNull();
      expect(r!.source).toBe("delivery-commit");
      expect(await filesOf(dir, r!.range)).toEqual(["consegna.ts"]);
    });

    test("il commit di consegna già dentro main risale al merge che ce l'ha portato", async () => {
      // Merge con un messaggio che non si fa trovare: resta il cammino.
      await git(dir, ["merge", "--no-ff", "-m", "landing a mano", "topics/card"]);
      await git(dir, ["branch", "-qD", "topics/card"]);
      await commit(dir, "dopo.txt", "altro\n", "lavoro successivo");

      expect(await landedMergeRange(dir, "T-42")).toBeNull();
      const r = await deliveryCommitRange(dir, { branch: "topics/card", commit: cardCommit });
      expect(r).not.toBeNull();
      expect(r!.source).toBe("landed-merge");
      expect(await filesOf(dir, r!.range)).toEqual(["consegna.ts"]);
    });

    test("un commit di consegna che non esiste più non produce il diff di qualcos'altro", async () => {
      expect(await deliveryCommitRange(dir, { branch: "topics/card", commit: "0".repeat(40) })).toBeNull();
      expect(await deliveryCommitRange(dir, { branch: "topics/card", commit: null })).toBeNull();
    });

    test("l'ordine è worktree → merge del land → commit di consegna", async () => {
      await git(dir, ["merge", "--no-ff", "-m", "merge task T-42: il titolo della card", "topics/card"]);

      // Il ramo c'è ancora: il worktree vivo vince, e porta anche l'albero.
      writeFileSync(join(dir, "non-committato.txt"), "vivo\n");
      const live = await resolveTaskDiffRange({ taskId: "T-42", worktree: { cwd: dir, branch: "topics/card" }, repoPath: dir });
      expect(live!.source).toBe("worktree");

      // Potato il ramo, risponde il merge.
      await git(dir, ["branch", "-qD", "topics/card"]);
      const landed = await resolveTaskDiffRange({
        taskId: "T-42", worktree: null, repoPath: dir,
        delivery: { branch: "topics/card", commit: cardCommit },
      });
      expect(landed!.source).toBe("landed-merge");
      expect(await filesOf(dir, landed!.range)).toEqual(["consegna.ts"]);

      // Senza checkout del progetto non resta niente da cui ricostruire.
      expect(await resolveTaskDiffRange({ taskId: "T-42", worktree: null, repoPath: null })).toBeNull();
    });
  });
});
