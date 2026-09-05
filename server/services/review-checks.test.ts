/**
 * @covers KANBAN-15
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync } from "fs";
import { slotAcquiredLine } from "../../shared/slot-acquired";
import {
  formatChecksComment,
  formatChecksWait,
  parseReviewChecks,
  runReviewChecks,
  serializeReviewChecks,
  failureTail,
  tailOf,
  MAX_CHECKS,
  NOT_MEASURED_EXIT,
  STATIC_RAILS_CHECK,
  type CheckRun,
  checksVerdict,
} from "./review-checks";

describe("parseReviewChecks", () => {
  test("forma lunga: nome e comando", () => {
    expect(parseReviewChecks('[{"name":"tipi","cmd":"bun run typecheck"}]'))
      .toEqual([{ name: "tipi", cmd: "bun run typecheck" }]);
  });

  test("forma corta: una stringa vale come nome e comando", () => {
    expect(parseReviewChecks('["bun test"]')).toEqual([{ name: "bun test", cmd: "bun test" }]);
  });

  test("nome vuoto ricade sul comando: una riga senza etichetta è comunque leggibile", () => {
    expect(parseReviewChecks('[{"name":"  ","cmd":"make"}]')).toEqual([{ name: "make", cmd: "make" }]);
  });

  test("scarta le voci senza comando invece di lasciarle passare vuote", () => {
    expect(parseReviewChecks('[{"name":"vuoto"},"",{"cmd":"  "},"ok"]'))
      .toEqual([{ name: "ok", cmd: "ok" }]);
  });

  // Un gate che esplode su config sporca bloccherebbe OGNI consegna della board
  // per un errore di battitura: meglio spento e visibile che rotto e misterioso.
  test("config illeggibile = nessun check, non un errore", () => {
    expect(parseReviewChecks("{non json")).toEqual([]);
    expect(parseReviewChecks('{"cmd":"x"}')).toEqual([]);
    expect(parseReviewChecks(null)).toEqual([]);
    expect(parseReviewChecks("   ")).toEqual([]);
  });

  test("tetto al numero di check", () => {
    const many = JSON.stringify(Array.from({ length: MAX_CHECKS + 3 }, (_, i) => `c${i}`));
    expect(parseReviewChecks(many)).toHaveLength(MAX_CHECKS);
  });
});

describe("serializeReviewChecks", () => {
  test("round-trip nella forma lunga", () => {
    const checks = [{ name: "tipi", cmd: "tsc" }];
    expect(parseReviewChecks(serializeReviewChecks(checks))).toEqual(checks);
  });

  test("lista vuota = NULL, cioè gate spento", () => {
    expect(serializeReviewChecks([])).toBeNull();
    expect(serializeReviewChecks([{ name: "x", cmd: "  " }])).toBeNull();
  });
});

describe("tailOf", () => {
  test("tiene la coda, che è dove sta l'errore", () => {
    const text = Array.from({ length: 100 }, (_, i) => `riga ${i}`).join("\n");
    const tail = tailOf(text, 3);
    expect(tail).toBe("riga 97\nriga 98\nriga 99");
  });

  test("output corto resta intero", () => {
    expect(tailOf("solo questa\n", 10)).toBe("solo questa");
  });
});

describe("failureTail", () => {
  // The shape that made this necessary: a red run whose last lines are all
  // skips, so the plain tail reported the counts and never the reason.
  const run = [
    "(fail) qualcosa > il caso che conta",
    "error: boom",
    ...Array.from({ length: 30 }, (_, i) => `(skip) rumore ${i} > sotto-caso`),
    "1 tests failed:",
    " 10 pass",
    " 1 fail",
  ].join("\n");

  test("the reason survives a wall of skipped tests", () => {
    const tail = failureTail(run, 6);
    expect(tail).toContain("(fail) qualcosa > il caso che conta");
    expect(tail).toContain("error: boom");
    expect(tail.split("\n").slice(1).join("\n")).not.toContain("(skip)");
  });

  test("it says how many green lines it dropped, so the tail is not a lie", () => {
    expect(failureTail(run, 6)).toContain("30 righe (pass)/(skip) omesse");
  });

  test("with no noise it behaves exactly like the plain tail", () => {
    const text = Array.from({ length: 100 }, (_, i) => `riga ${i}`).join("\n");
    expect(failureTail(text, 3)).toBe(tailOf(text, 3));
  });
});

describe("runReviewChecks", () => {
  // La cartella nasce e muore negli hook: creata nel corpo del describe e
  // cancellata in fondo, sparirebbe PRIMA che i test girino (il corpo è
  // sincrono, i test no) e ogni comando fallirebbe con "cwd inesistente".
  let cwd = "";
  beforeAll(() => { cwd = mkdtempSync(join(tmpdir(), "review-checks-")); });
  afterAll(() => { rmSync(cwd, { recursive: true, force: true }); });

  test("comando verde", async () => {
    const runs = await runReviewChecks([{ name: "ok", cmd: "echo tutto bene" }], { cwd });
    expect(runs).toHaveLength(1);
    expect(runs[0].ok).toBe(true);
    expect(runs[0].code).toBe(0);
    expect(runs[0].tail).toContain("tutto bene");
  });

  test("comando rosso: exit code e output finiscono nell'esito", async () => {
    const runs = await runReviewChecks([{ name: "ko", cmd: "echo esploso >&2; exit 3" }], { cwd });
    expect(runs[0].ok).toBe(false);
    expect(runs[0].code).toBe(3);
    expect(runs[0].tail).toContain("esploso");
  });

  // Un typecheck rotto rende inutile il lint che segue: farlo girare comunque
  // costa minuti per produrre rumore.
  test("si ferma al primo rosso", async () => {
    const runs = await runReviewChecks(
      [{ name: "a", cmd: "exit 1" }, { name: "b", cmd: "echo mai" }],
      { cwd },
    );
    expect(runs.map((r) => r.name)).toEqual(["a"]);
  });

  test("gira in ordine e riporta ogni verde", async () => {
    const runs = await runReviewChecks(
      [{ name: "a", cmd: "true" }, { name: "b", cmd: "true" }],
      { cwd },
    );
    expect(runs.map((r) => [r.name, r.ok])).toEqual([["a", true], ["b", true]]);
  });

  test("timeout: ucciso, rosso, e detto che è un timeout", async () => {
    const runs = await runReviewChecks([{ name: "lento", cmd: "sleep 5" }], { cwd, timeoutMs: 300 });
    expect(runs[0].ok).toBe(false);
    expect(runs[0].timedOut).toBe(true);
    expect(runs[0].code).toBeNull();
  }, 15_000);

  test("the slot line restarts the cap: queueing for a gate slot is not the command's time", async () => {
    // 1.5 s of "queue", the line slot.ts prints, then 1.5 s of "command": 3 s
    // in all against a 2 s cap. Without the line the check is killed (control
    // below); with it the cap restarts when the command starts, and the 1.5 s
    // of real work fit. The queue time is reported apart.
    const line = slotAcquiredLine("test:unit", 1500);
    const runs = await runReviewChecks(
      [{ name: "in coda", cmd: `sleep 1.5; echo '${line}' 1>&2; sleep 1.5` }],
      { cwd, timeoutMs: 2000 },
    );
    expect(runs[0].timedOut).toBe(false);
    expect(runs[0].ok).toBe(true);
    expect(runs[0].queuedMs).toBe(2000);
  }, 20_000);

  test("without the slot line the same 3 s against a 2 s cap is a timeout (control)", async () => {
    const runs = await runReviewChecks([{ name: "senza riga", cmd: "sleep 1.5; sleep 1.5" }], { cwd, timeoutMs: 2000 });
    expect(runs[0].timedOut).toBe(true);
    expect(runs[0].queuedMs).toBeUndefined();
  }, 20_000);

  // The cap is six and the repo has ten gates: the four missing from the
  // board's slots on 2026-09-03 went in as ONE chained slot. What makes a chain
  // an honest slot is the shell: `&&` stops at the first red and hands its
  // exit code through untouched, so a chained 97 still reads "not measured"
  // and a chained 1 still reads "red". Real `sh`, not a stub: the claim is
  // about the shell.
  test("una catena `&&` si ferma al primo rosso e ne propaga l'exit code intero", async () => {
    const [red] = await runReviewChecks(
      [{ name: "chain", cmd: "echo uno && exit 3 && echo mai" }],
      { cwd },
    );
    expect(red.ok).toBe(false);
    expect(red.code).toBe(3);
    expect(red.notMeasured).toBe(false);
    expect(red.tail).toContain("uno");
    expect(red.tail).not.toContain("mai");

    const [blind] = await runReviewChecks(
      [{ name: "chain", cmd: `echo uno && exit ${NOT_MEASURED_EXIT} && echo mai` }],
      { cwd },
    );
    expect(blind.code).toBe(NOT_MEASURED_EXIT);
    expect(blind.notMeasured).toBe(true);
    expect(checksVerdict([blind], 1)).toBe("unknown");
    expect(checksVerdict([red], 1)).toBe("fail");
  });

  test("cwd inesistente: rosso col motivo vero, non 'check fallito'", async () => {
    const runs = await runReviewChecks([{ name: "x", cmd: "true" }], { cwd: join(cwd, "non-esiste") });
    expect(runs[0].ok).toBe(false);
    expect(runs[0].spawnError).toBeTruthy();
  });

  test("abort prima di partire: nessun comando eseguito", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await runReviewChecks([{ name: "x", cmd: "true" }], { cwd, signal: ctrl.signal })).toEqual([]);
  });

  test("onProgress vede ogni comando appena finisce", async () => {
    const seen: string[] = [];
    await runReviewChecks([{ name: "a", cmd: "true" }, { name: "b", cmd: "true" }], {
      cwd,
      onProgress: (r) => seen.push(r.name),
    });
    expect(seen).toEqual(["a", "b"]);
  });

  // `git worktree add` materialises tracked files only, so a fresh task worktree
  // has no node_modules and every declared gate dies on exit 127 before it can
  // compile anything. Measured 2026-08-13: eight tasks carried that false red.
  // The commands are stubbed here — a real `bun install` in a unit test would be
  // minutes of network, and what is under test is the ORDER, not bun itself.
  const spia = () => {
    const visti: string[] = [];
    const spawn = async (check: { name: string; cmd: string }): Promise<CheckRun> => {
      visti.push(check.cmd);
      return { name: check.name, cmd: check.cmd, ok: true, code: 0, ms: 1, timedOut: false, tail: "" };
    };
    return { visti, spawn };
  };

  test("worktree senza dipendenze: installa PRIMA di misurare, radice e client", async () => {
    const { visti, spawn } = spia();
    const runs = await runReviewChecks([{ name: "tipi", cmd: "bun run typecheck" }], {
      cwd,
      spawn,
      missingInstallRoots: () => ["", "client"],
    });
    expect(visti).toEqual(["bun install", "cd client && bun install", "bun run typecheck"]);
    // Un'installazione verde è impianto, non un verdetto: il rapporto resta
    // quello dei cancelli dichiarati.
    expect(runs.map((r) => r.name)).toEqual(["tipi"]);
  });

  test("worktree calda: non installa niente", async () => {
    const { visti, spawn } = spia();
    await runReviewChecks([{ name: "tipi", cmd: "bun run typecheck" }], {
      cwd,
      spawn,
      missingInstallRoots: () => [],
    });
    expect(visti).toEqual(["bun run typecheck"]);
  });

  test("installazione rossa: lo dice, e i cancelli non partono nemmeno", async () => {
    const visti: string[] = [];
    const spawn = async (check: { name: string; cmd: string }): Promise<CheckRun> => {
      visti.push(check.cmd);
      const rotto = check.cmd.includes("bun install");
      return {
        name: check.name, cmd: check.cmd, ok: !rotto, code: rotto ? 1 : 0,
        ms: 1, timedOut: false, tail: rotto ? "lockfile incompatibile" : "",
      };
    };
    const runs = await runReviewChecks([{ name: "tipi", cmd: "bun run typecheck" }], {
      cwd,
      spawn,
      missingInstallRoots: () => ["", "client"],
    });
    expect(visti).toEqual(["bun install"]);
    expect(runs).toHaveLength(1);
    expect(runs[0].ok).toBe(false);
    expect(runs[0].name).toContain("bun install");
    expect(runs[0].tail).toContain("lockfile incompatibile");
  });

  test("nessun cancello dichiarato: non si installa per niente", async () => {
    const { visti, spawn } = spia();
    expect(await runReviewChecks([], { cwd, spawn, missingInstallRoots: () => ["", "client"] })).toEqual([]);
    expect(visti).toEqual([]);
  });
});

/**
 * THE STATIC RAILS FIT IN ONE SLOT, AND EVERY LINK IS A REAL SCRIPT.
 *
 * Measured 2026-09-03 on the live board: six slots, none of them
 * identifier-language, comment-language, untraced-tests or spec-coverage, and
 * main's CI finding the red after the land. The chain is the cure the settings
 * PATCH itself suggests ("unisci due comandi in uno solo"), and this file is
 * where its spelling lives, so the test pins two things: the four missing
 * gates are IN it, and every `bun run X` it names exists in package.json.
 * A chain that names a script nobody has is a slot that goes 1 on `bun run`
 * before measuring anything, indistinguishable from a red.
 */
describe("static-rails: la catena dei cancelli statici", () => {
  const links = STATIC_RAILS_CHECK.cmd.split(" && ");
  const scripts = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")).scripts as Record<string, string>;

  test("porta i quattro cancelli che i sei slot non avevano, oltre ai due che gia' c'erano", () => {
    for (const gate of [
      "check:emdash",
      "check:migrations",
      "check:identifier-language",
      "check:comment-language",
      "check:untraced-tests",
      "check:spec-coverage",
    ]) {
      expect(links).toContain(`bun run ${gate}`);
    }
  });

  test("ogni anello e' uno script dichiarato in package.json", () => {
    for (const link of links) {
      const m = /^bun run ([\w:-]+)$/.exec(link);
      expect(m, link).not.toBeNull();
      expect(scripts[m![1]!], link).toBeDefined();
    }
  });

  test("sta nei sei slot insieme agli altri cinque, e sopravvive al round-trip della config", () => {
    const six = [
      { name: "typecheck", cmd: "bun run typecheck" },
      { name: "lint", cmd: "bun run lint" },
      { name: "check:deadcode", cmd: "bun run check:deadcode" },
      STATIC_RAILS_CHECK,
      { name: "test:unit", cmd: "bun run test:unit" },
    ];
    expect(six.length).toBeLessThanOrEqual(MAX_CHECKS);
    expect(parseReviewChecks(serializeReviewChecks(six))).toEqual(six);
  });
});

describe("formatChecksComment", () => {
  const green: CheckRun = { name: "tipi", cmd: "tsc", ok: true, code: 0, ms: 1200, timedOut: false, tail: "" };

  test("verde: una riga sola, col commit su cui vale", () => {
    const out = formatChecksComment([green], { commit: "abcdef1234567890" });
    expect(out).toContain("verdi");
    expect(out).toContain("abcdef12");
    expect(out).toContain("`tipi`");
  });

  test("rosso: comando, exit code e coda dell'output", () => {
    const red: CheckRun = { name: "lint", cmd: "eslint .", ok: false, code: 2, ms: 800, timedOut: false, tail: "no-unused-vars" };
    const out = formatChecksComment([green, red]);
    expect(out).toContain("ROSSI");
    expect(out).toContain("exit 2");
    expect(out).toContain("eslint .");
    expect(out).toContain("no-unused-vars");
    // Il verde che l'ha preceduto resta visibile: dice fin dove si è arrivati.
    expect(out).toContain("✓ `tipi`");
  });

  test("timeout e mancato avvio si leggono diversi da un exit code", () => {
    const slow: CheckRun = { name: "e2e", cmd: "x", ok: false, code: null, ms: 1, timedOut: true, tail: "" };
    expect(formatChecksComment([slow])).toContain("tempo massimo");
    const dead: CheckRun = { name: "e2e", cmd: "x", ok: false, code: null, ms: 1, timedOut: false, tail: "", spawnError: "ENOENT" };
    expect(formatChecksComment([dead])).toContain("ENOENT");
  });

  test("uno SCADUTO non è un rosso: non ha misurato niente, e il testo non deve dirlo", () => {
    // Il 12/08 `b2a3e511` è stata bocciata da `test:unit` fermato al tetto
    // mentre cinque agenti lavoravano sulla stessa macchina. Il codice era sano:
    // a mancare era il tempo. Chiamarlo «ROSSI» manda l'agente a cercare un
    // guasto che non esiste, e la parola conta più del codice di stato.
    const scaduto: CheckRun = { name: "test:unit", cmd: "bun run test:unit", ok: false, code: null, ms: 600_000, timedOut: true, tail: "" };
    const out = formatChecksComment([scaduto]);
    expect(out).toContain("NON MISURATI");
    expect(out).not.toContain("ROSSI");
    expect(out).toContain("Non è un fallimento");

    // E il rosso VERO resta rosso, con la stessa parola di prima.
    const rosso: CheckRun = { name: "lint", cmd: "eslint .", ok: false, code: 2, ms: 800, timedOut: false, tail: "" };
    expect(formatChecksComment([rosso])).toContain("ROSSI");
  });

  test("nessun comando dichiarato non è un verde", () => {
    expect(formatChecksComment([])).not.toContain("verdi");
  });
});

/**
 * TRE ESITI, NON DUE — e il terzo non e' una sfumatura del secondo.
 *
 * `fail` dice «il tuo codice e' rotto, non approvare». `unknown` dice «non lo
 * sappiamo». Chi rivede decide diversamente nei due casi, e chi ha consegnato
 * pure: sul primo si va a cercare il guasto, sul secondo si rilancia.
 *
 * La distinzione esisteva dal 12/08 ma SOLO nel testo del commento, e il test
 * di sopra si chiudeva con «la parola conta piu' del codice di stato». Si e'
 * fermata li': `recordChecks` scriveva `ok ? "pass" : "fail"`, e la card legge
 * lo STATO — `checks_json` non viaggia nel payload della lista, pesava 217 KB.
 *
 * Misurato il 18/08 sul DB vivo: delle 15 card marcate `fail`, SEI erano solo
 * scadute. Il 40% delle bocciature accusava un codice sano.
 */
describe("checksVerdict: l'esito della barra in una parola", () => {
  const ok = (name: string): CheckRun => ({ name, cmd: name, ok: true, code: 0, ms: 10, timedOut: false, tail: "" });
  const rosso = (name: string): CheckRun => ({ name, cmd: name, ok: false, code: 2, ms: 10, timedOut: false, tail: "" });
  const scaduto = (name: string): CheckRun => ({ name, cmd: name, ok: false, code: null, ms: 1_200_000, timedOut: true, tail: "" });

  test("tutti verdi ⇒ pass", () => {
    expect(checksVerdict([ok("typecheck"), ok("lint")], 2)).toBe("pass");
  });

  test("un rosso vero ⇒ fail", () => {
    expect(checksVerdict([ok("typecheck"), rosso("lint")], 2)).toBe("fail");
  });

  test("SOLO scaduti ⇒ unknown: e' il caso che valeva il 40% delle bocciature", () => {
    expect(checksVerdict([ok("typecheck"), scaduto("test:unit")], 2)).toBe("unknown");
    expect(checksVerdict([scaduto("test:unit")], 1)).toBe("unknown");
  });

  test("un rosso VERO vince su uno scaduto: un guasto misurato non si nasconde", () => {
    // Il verso opposto sarebbe il difetto: un rosso reale mascherato da «non
    // lo sappiamo» farebbe approvare codice rotto.
    expect(checksVerdict([rosso("lint"), scaduto("test:unit")], 2)).toBe("fail");
    expect(checksVerdict([scaduto("test:unit"), rosso("lint")], 2)).toBe("fail");
  });

  test("elenco piu' CORTO dei comandi dichiarati ⇒ unknown, anche se e' tutto verde", () => {
    // Un comando che non e' mai tornato non e' un verde. Senza `expected` questo
    // caso direbbe `pass` su una barra girata a meta'.
    expect(checksVerdict([ok("typecheck")], 5)).toBe("unknown");
    expect(checksVerdict([ok("typecheck")], 1)).toBe("pass");
  });

  test("nessun comando ⇒ unknown, non pass", () => {
    // Zero misure non sono un verde. `pass` qui autorizzerebbe il direttore a
    // chiudere una card su cui non ha girato niente (vedi `whoCloses`).
    expect(checksVerdict([], 0)).toBe("unknown");
  });

  test("il TESTO e lo STATO dicono la stessa cosa: un predicato solo", () => {
    // E' la ragione per cui `checksVerdict` e' stata estratta invece di
    // duplicata: due copie che divergono rimetterebbero in piedi il difetto,
    // con la card che dice rosso mentre il thread dice «non misurati».
    const onlyExpired = [ok("typecheck"), scaduto("test:unit")];
    expect(checksVerdict(onlyExpired)).toBe("unknown");
    expect(formatChecksComment(onlyExpired)).toContain("NON MISURATI");
    const conRosso = [rosso("lint"), scaduto("test:unit")];
    expect(checksVerdict(conRosso)).toBe("fail");
    expect(formatChecksComment(conRosso)).toContain("ROSSI");
  });
});

/**
 * UN CANCELLO CHE NON PARTE NON E' UN ROSSO — ed e' diverso anche da uno SCADUTO.
 *
 * I worktree di dispatch nascono da `git worktree add`, che copia i file
 * TRACCIATI: `client/node_modules` non lo e', quindi non c'e'. Misurato il
 * 18/08: 95 worktree su 103 senza. Li' `eslint` e `tsc` non partono, i loro
 * script uscivano 1, e la card scriveva `checks_state = 'fail'` — «il tuo codice
 * e' rotto» su rami che spesso non avevano nemmeno un commit. E' il falso rosso
 * piu' diffuso della board.
 *
 * `97` e' il codice con cui quei due dichiarano «non ho misurato». La
 * distinzione la facevano gia' A PAROLE («Il typecheck NON e' girato»), ma
 * l'uscita 1 la buttava via: chi legge l'esito vede il numero.
 */
describe("uscita 97: non misurato, e si legge diverso da scaduto", () => {
  const nonPartito: CheckRun = {
    name: "lint", cmd: "bun run lint", ok: false, code: 97, ms: 40,
    timedOut: false, notMeasured: true, tail: "eslint non c'e'",
  };
  const scaduto: CheckRun = {
    name: "test:unit", cmd: "bun run test:unit", ok: false, code: null, ms: 1_200_000,
    timedOut: true, tail: "",
  };
  const rosso: CheckRun = {
    name: "lint", cmd: "eslint .", ok: false, code: 2, ms: 800, timedOut: false, tail: "no-unused-vars",
  };

  test("il verdetto e' `unknown`, non `fail`", () => {
    expect(checksVerdict([nonPartito], 1)).toBe("unknown");
  });

  test("un rosso VERO accanto vince comunque: un guasto misurato non si nasconde", () => {
    expect(checksVerdict([nonPartito, rosso], 2)).toBe("fail");
  });

  test("il testo non dice «fermato oltre il tempo massimo»: non e' vero", () => {
    // E' la ragione per cui `notMeasured` e' un campo suo e non un riuso di
    // `timedOut`: il testo dello scaduto manda a «rilancia quando c'e' meno
    // traffico», che su un binario assente e' una caccia a un guasto che non c'e'.
    const out = formatChecksComment([nonPartito]);
    expect(out).toContain("NON MISURATI");
    expect(out).toContain("non e' partito");
    expect(out).not.toContain("tempo massimo");
    expect(out).not.toContain("ROSSI");
  });

  test("lo SCADUTO tiene il suo testo, che e' un'altra cosa", () => {
    const out = formatChecksComment([scaduto]);
    expect(out).toContain("NON MISURATI");
    expect(out).toContain("tempo massimo");
  });
});


describe("formatChecksWait: la riga che la chat mostra mentre i check girano", () => {
  const names = ["typecheck", "lint", "check:deadcode", "static-rails", "test:unit"];

  test("a metà barra dice quanti sono passati, quale gira e quali aspettano", () => {
    const line = formatChecksWait({ done: 2, total: 5, names, elapsedMs: 71_000 });
    expect(line).toContain("Check pre-review 2/5 (1m11s)");
    expect(line).toContain("verdi: typecheck, lint");
    expect(line).toContain("in corso: check:deadcode");
    expect(line).toContain("poi: static-rails, test:unit");
    // The reader is the person in the thread: they must see the wait is not the agent's.
    expect(line).toContain("non l'agente");
  });

  test("in coda dietro un'altra card lo dice, senza inventare un comando in corso", () => {
    const line = formatChecksWait({ done: null, total: 5, names, elapsedMs: 9_000 });
    expect(line).toContain("in coda dietro un'altra card (9s)");
    expect(line).not.toContain("in corso:");
  });

  test("all'ultimo comando non resta niente «poi», e un done oltre il totale non sfonda", () => {
    const last = formatChecksWait({ done: 4, total: 5, names, elapsedMs: 600_000 });
    expect(last).toContain("4/5 (10m00s)");
    expect(last).toContain("in corso: test:unit");
    expect(last).not.toContain("poi:");
    expect(formatChecksWait({ done: 9, total: 5, names, elapsedMs: 0 })).toContain("5/5 (0s)");
  });
});
