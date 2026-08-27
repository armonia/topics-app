/**
 * The expiry decision and the gesture that plants the ref, tested apart: the
 * first is pure arithmetic, the second talks to git and is tried on a real
 * repository. The proof that counts (a delivery surviving `branch -D` plus
 * `gc --prune=now`) lives in `tests/integration/delivery-ref-survives-gc.test.ts`.
 *
 * @covers LAND-09
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gitEnv } from "../../tests/setup/bun-test-preload";
import {
  decideDeliveryRefDrop,
  deliveryRefName,
  keepDeliveryCommit,
  listKeptDeliveries,
  pruneDeliveryRefs,
  taskIdOfDeliveryRef,
} from "./delivery-ref-keep";
import { createDeliveryCapture } from "./task-delivery-capture";

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-22T12:00:00.000Z");
const isoDaysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  return new TextDecoder().decode(r.stdout).trim();
}

describe("il nome del ref", () => {
  test("un id di card diventa un ref sotto il suo spazio", () => {
    const ref = deliveryRefName("67622704-17f6-484c-b73c-7f8e45704c12");
    expect(ref).toBe("refs/consegne/67622704-17f6-484c-b73c-7f8e45704c12");
    expect(taskIdOfDeliveryRef(ref!)).toBe("67622704-17f6-484c-b73c-7f8e45704c12");
  });

  test("un id che uscirebbe dallo spazio dei nomi non diventa un ref", () => {
    // None of these is a uuid, and that is the point: the day a card id comes
    // from somewhere else, the ref must not be writable anywhere else in the
    // repository.
    for (const cattivo of ["../heads/main", "a/b", "-x", "a..b", "x.lock", "", "a b"]) {
      expect(deliveryRefName(cattivo)).toBeNull();
    }
  });

  test("un ref che non è dei nostri non torna indietro come id", () => {
    expect(taskIdOfDeliveryRef("refs/heads/main")).toBeNull();
    expect(taskIdOfDeliveryRef("refs/consegne/")).toBeNull();
  });
});

describe("quando un ref di consegna ha finito il suo lavoro", () => {
  test("card chiusa da più della finestra: si lascia cadere", () => {
    const v = decideDeliveryRefDrop({ status: "done", completedAt: isoDaysAgo(91) }, NOW, 90);
    expect(v).toEqual({ drop: true, reason: "expired" });
  });

  test("card chiusa da meno: si tiene", () => {
    expect(decideDeliveryRefDrop({ status: "done", completedAt: isoDaysAgo(89) }, NOW, 90).drop).toBe(false);
  });

  test("card ancora aperta: si tiene, comunque sia datata", () => {
    for (const stato of ["todo", "in_progress", "review", "backlog"]) {
      expect(decideDeliveryRefDrop({ status: stato, completedAt: isoDaysAgo(400) }, NOW, 90).drop).toBe(false);
    }
  });

  test("card sconosciuta al database: si tiene, non si cancella ciò che non si sa", () => {
    // One repository can carry the deliveries of more than one board. «I do not
    // know it» is not «it is no longer needed»: dropping is irreversible,
    // keeping costs 41 bytes.
    expect(decideDeliveryRefDrop({ status: null, completedAt: null }, NOW, 90))
      .toEqual({ drop: false, reason: "unknown" });
  });

  test("chiusa ma senza data (o con una data illeggibile): si tiene", () => {
    expect(decideDeliveryRefDrop({ status: "done", completedAt: null }, NOW, 90).reason).toBe("undated");
    expect(decideDeliveryRefDrop({ status: "done", completedAt: "mai" }, NOW, 90).reason).toBe("undated");
  });

  test("finestra a zero: non scade niente, mai", () => {
    expect(decideDeliveryRefDrop({ status: "done", completedAt: isoDaysAgo(4000) }, NOW, 0))
      .toEqual({ drop: false, reason: "forever" });
  });
});

describe("piantare e potare su git vero", () => {
  let repo: string;
  let root: string;
  let consegna = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "delivery-ref-"));
    repo = join(root, "repo");
    Bun.spawnSync(["git", "init", "-q", "-b", "main", repo], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "base");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    git(repo, "checkout", "-q", "-b", "topics/card");
    writeFileSync(join(repo, "b.txt"), "lavoro della card");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "consegna");
    consegna = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "main");
  }, 30_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("il ref si pianta e il repo lo elenca con lo sha intero", async () => {
    expect(await keepDeliveryCommit({ repoPath: repo, taskId: "card-uno", commit: consegna.slice(0, 8) })).toBe(true);
    const tenute = await listKeptDeliveries(repo);
    expect(tenute).toEqual([{ taskId: "card-uno", ref: "refs/consegne/card-uno", commit: consegna }]);
  });

  test("uno sha che non esiste non pianta niente", async () => {
    expect(await keepDeliveryCommit({ repoPath: repo, taskId: "card-due", commit: "a".repeat(40) })).toBe(false);
    expect(await keepDeliveryCommit({ repoPath: repo, taskId: "card-due", commit: "non-uno-sha" })).toBe(false);
    expect((await listKeptDeliveries(repo))?.some((r) => r.taskId === "card-due")).toBe(false);
  });

  test("un oggetto che non è un commit non si pianta: un ref che punta a un albero risponderebbe a un'altra domanda", async () => {
    const albero = git(repo, "rev-parse", "HEAD^{tree}");
    expect(await keepDeliveryCommit({ repoPath: repo, taskId: "card-albero", commit: albero })).toBe(false);
  });

  test("una cartella che non è un repo non è un errore: torna false", async () => {
    expect(await keepDeliveryCommit({ repoPath: root, taskId: "card-tre", commit: consegna })).toBe(false);
  });

  test("la potatura lascia cadere solo le card chiuse da troppo", async () => {
    await keepDeliveryCommit({ repoPath: repo, taskId: "vecchia", commit: consegna });
    await keepDeliveryCommit({ repoPath: repo, taskId: "recente", commit: consegna });
    await keepDeliveryCommit({ repoPath: repo, taskId: "aperta", commit: consegna });
    const vite: Record<string, { status: string | null; completedAt: string | null }> = {
      vecchia: { status: "done", completedAt: isoDaysAgo(200) },
      recente: { status: "done", completedAt: isoDaysAgo(3) },
      aperta: { status: "in_progress", completedAt: null },
    };
    const summary = await pruneDeliveryRefs({
      repoPath: repo,
      now: NOW,
      retentionDays: 90,
      lifeOf: (id) => vite[id] ?? { status: null, completedAt: null },
    });
    expect(summary?.dropped).toEqual(["vecchia"]);
    const rimasti = (await listKeptDeliveries(repo))!.map((r) => r.taskId);
    expect(rimasti).toContain("recente");
    expect(rimasti).toContain("aperta");
    expect(rimasti).not.toContain("vecchia");
  });

  test("su una cartella che non è un repo la potatura non dice niente invece di indovinare", async () => {
    expect(await pruneDeliveryRefs({ repoPath: root, lifeOf: () => ({ status: "done", completedAt: isoDaysAgo(999) }) }))
      .toBeNull();
  });
});

describe("la cattura pianta il ref PRIMA di scrivere la colonna", () => {
  test("l'ordine è quello, ed è tutta la sicurezza del meccanismo", async () => {
    const ordine: string[] = [];
    const capture = createDeliveryCapture({
      svc: {
        recordDelivery: () => { ordine.push("colonna"); },
        deriveLabelsFromDiff: () => {},
      },
      taskDeliveryRef: async () => ({ branch: "topics/card", commit: "a".repeat(40), repoPath: "/repo" }),
      keepDeliveryCommit: async () => { ordine.push("ref"); },
      ownCommitFiles: async () => null,
    });
    expect(await capture("card")).toBe(true);
    expect(ordine).toEqual(["ref", "colonna"]);
  });

  test("git che inciampa sul ref non fa saltare la consegna", async () => {
    let scritta = false;
    const capture = createDeliveryCapture({
      svc: {
        recordDelivery: () => { scritta = true; },
        deriveLabelsFromDiff: () => {},
      },
      taskDeliveryRef: async () => ({ branch: "topics/card", commit: "a".repeat(40), repoPath: "/repo" }),
      keepDeliveryCommit: async () => { throw new Error("git esploso"); },
      ownCommitFiles: async () => null,
    });
    expect(await capture("card")).toBe(true);
    expect(scritta).toBe(true);
  });

  test("senza commit non c'è niente da tenere vivo: git non viene disturbato", async () => {
    let chiamate = 0;
    const capture = createDeliveryCapture({
      svc: { recordDelivery: () => {}, deriveLabelsFromDiff: () => {} },
      taskDeliveryRef: async () => ({ branch: "topics/card", commit: null, repoPath: "/repo" }),
      keepDeliveryCommit: async () => { chiamate += 1; },
      ownCommitFiles: async () => null,
    });
    expect(await capture("card")).toBe(true);
    expect(chiamate).toBe(0);
  });
});
