/**
 * I cancelli del confronto a tre bracci.
 *
 * Due cose che possono marcire da sole e che nessuno vedrebbe:
 *  1. La REPLICA dell'envelope di dispatch (`buildKickoffReplica`) è testo
 *     ricopiato da `buildKickoff`, che è privata del dispatcher. Se il
 *     dispatcher cambia frase, la replica misura un envelope che non esiste
 *     più — e il numero del braccio `board-sim` diventa una finzione senza che
 *     niente diventi rosso. Qui le frasi-ancora si cercano nel sorgente vero.
 *  2. Il BUNDLE dei risultati: `workTokens` deve restare input+output+cacheWrite
 *     e i cache-read devono restare fuori. Il giorno che qualcuno li somma «per
 *     comodità» il totale gonfia ~2,5× e il confronto mente.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ARM_IDS,
  ARMS_FILE,
  BUNDLE_SCHEMA,
  KICKOFF_DRIFT_ANCHORS,
  MICRO_TASK_TEXT,
  ROLE_PROMPT_REPLICA,
  PAIR_DIR,
  buildKickoffReplica,
  loadArmBundle,
  sha256,
  treeProvenanceNote,
  validateArmBundle,
} from "./board-arms";

const REPO = resolve(import.meta.dir, "..");
const dispatcherSrc = readFileSync(join(REPO, "server/services/task-dispatcher.ts"), "utf8");

describe("replica dell'envelope di dispatch", () => {
  it("ogni frase-ancora esiste ancora nel dispatcher", () => {
    const missing = KICKOFF_DRIFT_ANCHORS.filter((a) => !dispatcherSrc.includes(a));
    expect(missing).toEqual([]);
  });

  it("il role prompt replicato è quello di rolePrompt()", () => {
    // rolePrompt() concatena tre stringhe: cerco i pezzi, non la somma.
    for (const chunk of [
      "You are an agent working ONE SINGLE task of a Kanban board, in the current working directory, ",
      "up to the `review` state. Minimal communication: short status comments at the milestones. ",
      "You cannot take the task to `done` (that needs the human's ok).",
    ]) {
      expect(dispatcherSrc).toContain(chunk);
      expect(ROLE_PROMPT_REPLICA).toContain(chunk.trim());
    }
  });

  it("il kickoff replicato incornicia il task come DATO e chiude con «Start now.»", () => {
    const k = buildKickoffReplica({ id: "T1", text: "titolo", description: "corpo" });
    expect(k).toContain("You are the exclusive owner of task `T1`");
    expect(k).toContain("--- TASK ---");
    expect(k).toContain("corpo");
    expect(k.trimEnd().endsWith("Start now.")).toBe(true);
    // Nessun blocco plan-first: la replica dichiara planFirst=false.
    expect(k).not.toContain("PLAN FIRST");
  });
});

describe("validazione del bundle", () => {
  const armStub = (over: Record<string, unknown> = {}) => ({
    arm: "cli",
    sandboxTreeSha: "treesha-1",
    model: "m",
    effort: "medium",
    usage: { inputTokens: 10, outputTokens: 5, cacheWriteTokens: 2, cacheWrite1hTokens: 0, cacheReadTokens: 999, workTokens: 17 },
    ...over,
  });
  const bundleStub = (over: Record<string, unknown> = {}) => ({
    schema: BUNDLE_SCHEMA,
    baseCommit: "abcdef1234",
    baseTreeSha: "treesha-1",
    microTaskSha256: sha256(MICRO_TASK_TEXT),
    paired: true,
    // Schema @2: l'effort e' per braccio, e `sameEffort` lo dichiara. Uno stub
    // senza questi campi non e' "coerente": e' un bundle vecchio.
    sameEffort: true,
    effortByArm: { cli: "medium" },
    arms: [armStub()],
    replicates: [],
    summary: [{ arm: "cli", runs: 1 }],
    ...over,
  });

  it("un bundle coerente non ha problemi", () => {
    expect(validateArmBundle(bundleStub())).toEqual([]);
  });

  it("boccia i cache-read sommati dentro workTokens", () => {
    const bad = bundleStub({
      arms: [armStub({ usage: { inputTokens: 10, outputTokens: 5, cacheWriteTokens: 2, cacheWrite1hTokens: 0, cacheReadTokens: 999, workTokens: 1016 } })],
    });
    expect(validateArmBundle(bad).join(" ")).toContain("cache-read");
  });

  it("boccia un `paired: true` con alberi di partenza diversi", () => {
    const bad = bundleStub({
      arms: [armStub(), armStub({ arm: "chat", sandboxTreeSha: "treesha-2" })],
      summary: [{ arm: "cli", runs: 1 }, { arm: "chat", runs: 1 }],
    });
    expect(validateArmBundle(bad).join(" ")).toContain("paired dichiarato true");
  });

  /**
   * L'albero su cui le corse hanno girato va SCRITTO. Senza, il lettore ha solo
   * `baseCommit`, il cui `^{tree}` non coincide con quello delle sandbox — e da
   * lì è già uscita la diagnosi sbagliata «misure prese da una working tree
   * sporca». Un numero su cui poggia l'appaiamento non si deduce.
   */
  it("boccia un bundle senza baseTreeSha", () => {
    const bad = bundleStub();
    delete (bad as Record<string, unknown>).baseTreeSha;
    expect(validateArmBundle(bad).join(" ")).toContain("baseTreeSha mancante");
  });

  it("boccia un baseTreeSha che non è quello delle corse", () => {
    const bad = bundleStub({ baseTreeSha: "tree-inventato" });
    expect(validateArmBundle(bad).join(" ")).toContain("sandboxTreeSha diverso");
  });

  it("boccia un braccio con più corse degli altri (min/max non confrontabili)", () => {
    const bad = bundleStub({
      arms: [armStub(), armStub({ arm: "chat" })],
      replicates: [armStub()],
      summary: [{ arm: "cli", runs: 2 }, { arm: "chat", runs: 1 }],
    });
    expect(validateArmBundle(bad).join(" ")).toContain("corse per braccio disuguali");
  });
});

describe("i numeri registrati", () => {
  it("il bundle sul disco è leggibile, appaiato e copre i tre bracci", () => {
    const bundle = loadArmBundle(join(REPO, ARMS_FILE)); // lancia se non valida
    expect(bundle.microTaskSha256).toBe(sha256(MICRO_TASK_TEXT));
    expect(bundle.arms.map((a) => a.arm).sort()).toEqual([...ARM_IDS].sort());
    // Se questo è false il confronto è NULLO e va detto, non aggiustato.
    expect(bundle.paired).toBe(true);
    for (const a of [...bundle.arms, ...bundle.replicates]) {
      expect(a.usage.workTokens).toBe(a.usage.inputTokens + a.usage.outputTokens + a.usage.cacheWriteTokens);
      expect(a.usage.cacheReadTokens).toBeGreaterThan(0);
      expect(a.transcriptPath).toBeTruthy();
    }
  });

  it("ogni braccio ha lo stesso numero di corse, e ogni corsa ha consegnato o è marcata come non consegnata", () => {
    const bundle = loadArmBundle(join(REPO, ARMS_FILE));
    const runs = new Set(bundle.summary.map((s) => s.runs));
    expect([...runs]).toHaveLength(1);
    // `delivered` non deve MAI essere dedotto: viene dal test dell'agente che
    // gira davvero più dalla sonda `--json`. Qui si controlla solo che il conto
    // di summary combaci con le corse.
    for (const s of bundle.summary) {
      const all = [...bundle.arms, ...bundle.replicates].filter((a) => a.arm === s.arm);
      expect(s.delivered).toBe(all.filter((a) => a.delivered).length);
    }
  });

  /**
   * L'ancora del confronto è il TREE, non il commit: le nove corse girano su
   * sandbox rimaterializzate, e il tree sha che ne esce non è un oggetto di
   * questo repo. Scriverlo (e spiegarlo) è ciò che impedisce la lettura
   * sbagliata «il tree non torna, quindi le misure vengono dallo sporco».
   */
  it("il bundle dichiara il tree su cui le corse hanno girato, e spiega perché non è un oggetto del repo", () => {
    const bundle = loadArmBundle(join(REPO, ARMS_FILE));
    expect(bundle.baseTreeSha.length).toBeGreaterThan(7);
    for (const a of [...bundle.arms, ...bundle.replicates]) {
      expect(a.sandboxTreeSha).toBe(bundle.baseTreeSha);
    }
    expect(bundle.pairingNotes).toContain(treeProvenanceNote(bundle.baseCommit, bundle.baseTreeSha));
  });

  /**
   * Il difetto che questa riga chiude: nelle terne finiva
   * `humanActionsUiHappyPath`, cioè una COSTANTE del sorgente (3), sotto il nome
   * `humanActions`. Il cancello del tetto confrontava un letterale con un
   * letterale — rosso identico in tutte le repliche, mai variabile, e una sola
   * decisione di progetto contata tre volte come tre fallimenti di misura.
   */
  it("le terne portano le azioni umane MISURATE, non il conto a mano dell'interfaccia", () => {
    const bundle = loadArmBundle(join(REPO, ARMS_FILE));
    const byArm = new Map([...bundle.arms, ...bundle.replicates].map((a) => [`${a.arm}:${a.transcriptPath}`, a]));
    const files = [1, 2, 3].map((i) => join(REPO, PAIR_DIR, `t1-appaiato-${i}.pair.json`));
    let boardRuns = 0;
    for (const f of files) {
      const parsed = JSON.parse(readFileSync(f, "utf8")) as {
        workId?: string;
        runs: Array<{ arm: string; transcriptPath?: string; humanActions?: number; humanActionsStructural?: number }>;
      };
      expect(parsed.workId).toBe(bundle.microTaskId);
      for (const r of parsed.runs) {
        const armId = r.arm === "board" ? "board-sim" : r.arm;
        const m = byArm.get(`${armId}:${r.transcriptPath}`);
        expect(m).toBeDefined();
        expect(r.humanActions).toBe(m?.humanActions);
        expect(r.humanActionsStructural).toBe(m?.humanActionsUiHappyPath);
        if (r.arm === "board") {
          boardRuns += 1;
          // Il numero misurato e il numero a mano DEVONO stare in due campi
          // diversi, altrimenti il difetto rientra dalla finestra.
          expect(r.humanActions).not.toBe(r.humanActionsStructural);
        }
      }
    }
    expect(boardRuns).toBe(3);
  });

  it("l'ordine per costo dentro ogni terna è ricalcolabile dai dati", () => {
    const bundle = loadArmBundle(join(REPO, ARMS_FILE));
    const triples: (typeof bundle.arms)[] = [bundle.arms];
    for (let i = 0; i < bundle.replicates.length; i += bundle.arms.length) {
      triples.push(bundle.replicates.slice(i, i + bundle.arms.length));
    }
    expect(bundle.costOrderingPerTriple).toHaveLength(triples.length);
    triples.forEach((t, i) => {
      const expected = [...t].sort((a, b) => a.costUsd - b.costUsd).map((a) => a.arm).join(" < ");
      expect(bundle.costOrderingPerTriple[i]).toBe(expected);
    });
  });
});
