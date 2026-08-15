#!/usr/bin/env bun
/**
 * IL CANCELLO DELLA FLUIDITA'.
 *
 *   bun run check:scroll-fluidity                    misura e giudica
 *   bun run check:scroll-fluidity -- --from FILE.json  giudica una misura gia' fatta
 *   bun run check:scroll-fluidity -- --update-baseline registra i numeri nuovi
 *
 * PERCHE'. «Fluido» era una parola in una card, e una parola non puo' fallire.
 * Questo repo misura il bundle, i tipi, la densita' di `any`, i frame chiesti a
 * RIPOSO. Non aveva un solo numero su cosa succede al main thread MENTRE si
 * scorre, che e' l'unico momento in cui l'utente la fluidita' la sente.
 *
 * COME SI DIVIDONO I COMPITI. La MISURA sta in
 * `tests/e2e/scroll-fluidity.spec.ts`, che scorre il trascritto di una chat e
 * scrive un JSON; il GIUDIZIO sta qui. La separazione non e' estetica: dentro la
 * suite quella spec fallisce solo se il banco non regge, mai per una soglia,
 * cosi' la suite non diventa rossa perche' il portatile stava indicizzando. La
 * soglia si fa valere quando qualcuno la chiede, cioe' lanciando questo comando.
 *
 * TRE NUMERI, perche' una fluidita' si rompe in tre modi che non si implicano:
 * la quota di frame persi (lo scatto continuo), il buco peggiore fra due frame
 * (lo strappo singolo, che in percentuale non si vedrebbe) e i millisecondi
 * passati dentro task lunghi (la causa: lavoro sul main thread).
 *
 * TRE USCITE, e la distinzione conta:
 *   0  dentro il budget
 *   1  REGRESSIONE: la superficie ha perso fluidita'
 *   2  NON MISURABILE: la misura non parla del prodotto (macchina che non
 *      consegna frame nemmeno da ferma, banco che non ha scorso niente, misura
 *      piu' vecchia della run). Un cancello che confonde questi due casi finisce
 *      per non essere creduto, ed e' peggio di nessun cancello.
 *
 * COME LO SI VEDE ROSSO. `TOPICS_FLUIDO_JANK_MS=70 bun run check:scroll-fluidity` blocca
 * davvero il main thread della pagina a intervalli regolari. Iniettare lentezza
 * vera prova che la sonda vede un'app che scatta; abbassare la soglia proverebbe
 * soltanto che una disuguaglianza funziona.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts/scroll-fluidity-baseline.json");
const SPEC_PATH = "tests/e2e/scroll-fluidity.spec.ts";

/**
 * IL NOME `fluido` SOPRAVVIVE QUI, e non per distrazione.
 *
 * Questo percorso e le variabili `TOPICS_FLUIDO_*` sono il contratto con
 * `tests/e2e/scroll-fluidity.spec.ts`: e' la spec a scrivere il file e a leggere
 * quelle variabili, e i due lati devono cambiare nello STESSO edit o la misura
 * finisce in un posto e il giudizio la cerca in un altro. Il rinomino della spec
 * e' un edit a se': quando lo si fa, si spostano anche queste tre righe e la
 * riga 34 qui sopra.
 */
const DEFAULT_OUT = join(REPO_ROOT, "test-results/fluido-measure.json");

export interface Measurement {
  measured_at?: string;
  jank_injected_ms?: number;
  calibration_gap_ms: number;
  median: {
    dropped_pct: number;
    worst_gap_ms: number;
    longtask_ms: number;
    longtask_count?: number;
    median_gap_ms?: number;
  };
  witness: { scroll_span_px: number; render_churn: number };
}

export interface Baseline {
  budget: { dropped_pct: number; worst_gap_ms: number; longtask_ms: number };
  guards: {
    calibration_gap_ms_ceiling: number;
    scroll_span_px_floor: number;
    render_churn_floor: number;
  };
  update_rule: Record<string, { floor: number; multiplier: number }>;
  measured: Record<string, unknown>;
}

/** 0 verde, 1 regressione, 2 non misurabile. Vedi l'intestazione. */
export type ExitCode = 0 | 1 | 2;

export interface Verdict {
  exitCode: ExitCode;
  /** Le righe della tabella misurato-contro-budget, sempre stampate. */
  rows: string[];
  /** Cosa ha sforato. Vuoto quando l'uscita non e' 1. */
  exceeded: string[];
  /** Perche' la misura non vale niente. Vuoto quando l'uscita non e' 2. */
  blockers: string[];
}

/** Le tre metriche giudicate, in un posto solo: nome, dove sta, come si legge. */
const METRICS = [
  { key: "dropped_pct", label: "frame persi", unit: "%" },
  { key: "worst_gap_ms", label: "buco peggiore", unit: "ms" },
  { key: "longtask_ms", label: "long task", unit: "ms" },
] as const;

/**
 * Il giudizio, puro: due oggetti dentro, un esito fuori.
 *
 * Puro perche' sia falsificabile senza un browser: `scripts/check-scroll-fluidity.test.ts`
 * gli passa misure sintetiche, comprese quelle che DEVONO uscire rosse.
 *
 * `notBefore`, quando c'e', e' l'istante in cui e' partita la misura: una
 * misura piu' vecchia della run e' un artefatto di prima, e giudicarla
 * significherebbe dare il verde a codice che non e' mai stato provato.
 */
export function judge(m: Measurement, b: Baseline, notBefore?: Date): Verdict {
  const rows: string[] = [];
  const exceeded: string[] = [];
  const blockers: string[] = [];

  for (const { key, label, unit } of METRICS) {
    const got = m.median[key];
    const max = b.budget[key];
    const within = got <= max;
    rows.push(
      `${within ? "  " : "✗ "}${label.padEnd(14)} ${String(got).padStart(8)} ${unit.padEnd(2)}` +
        `   budget ${max} ${unit}`,
    );
    if (!within) exceeded.push(`${key}: ${got}${unit} > ${max}${unit}`);
  }

  const g = b.guards;

  /**
   * UN TESTIMONE CHE MANCA E' UN TESTIMONE CHE ACCUSA, non uno che tace.
   *
   * Qui c'era `m.witness.scroll_span_px < soglia` e basta: se il campo MANCAVA,
   * `undefined < 2000` e' false, quindi nessun impedimento e uscita verde.
   * Provato: con `"witness": {}` il cancello stampava «testimoni undefinedpx
   * percorsi» e poi «dentro il budget». Cioe' bastava rinominare un campo nella
   * spec perche' la difesa che questo cancello dichiara come propria si
   * spegnesse in silenzio, e per sempre.
   */
  const numberOrNull = (v: unknown, name: string): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    blockers.push(
      `il testimone \`${name}\` non e' un numero (${JSON.stringify(v)}): ` +
        `senza di lui non si sa se il banco abbia misurato qualcosa, e una misura ` +
        `che non si sa se e' avvenuta non si giudica`,
    );
    return null;
  };

  if (m.calibration_gap_ms > g.calibration_gap_ms_ceiling) {
    blockers.push(
      `calibrazione ${m.calibration_gap_ms}ms > ${g.calibration_gap_ms_ceiling}ms: ` +
        `questa macchina non consegna frame nemmeno su una pagina vuota, quindi ` +
        `qualunque numero raccolto sotto scorrimento parla di lei e non dell'app`,
    );
  }
  const span = numberOrNull(m.witness?.scroll_span_px, "scroll_span_px");
  if (span !== null && span < g.scroll_span_px_floor) {
    blockers.push(
      `il banco ha percorso ${span}px < ${g.scroll_span_px_floor}px: ` +
        `non ha scorso abbastanza perche' la misura voglia dire qualcosa`,
    );
  }
  const churn = numberOrNull(m.witness?.render_churn, "render_churn");
  if (churn !== null && churn < g.render_churn_floor) {
    blockers.push(
      `la virtualizzazione ha cambiato item ${churn} volte < ${g.render_churn_floor}: ` +
        `il banco ha scorso senza far montare niente, e zero lavoro da' sempre zero frame persi`,
    );
  }
  // Stessa asimmetria di prima su `measured_at`: era opzionale, quindi se la
  // spec avesse smesso di scriverlo il controllo di freschezza sarebbe sparito
  // senza un rumore. Adesso la sua assenza e' un impedimento come gli altri.
  if (notBefore && !m.measured_at) {
    blockers.push(
      `la misura non porta \`measured_at\`: non si puo' dire se e' di questo giro ` +
        `o l'artefatto di uno precedente`,
    );
  }
  if (notBefore && m.measured_at && new Date(m.measured_at) < notBefore) {
    blockers.push(
      `la misura e' del ${m.measured_at}, cioe' PRIMA di questa run: ` +
        `e' l'artefatto di un giro precedente e non dice niente sul codice di adesso`,
    );
  }

  // L'impedimento vince sullo sforo: se la misura non vale, il rosso che darebbe
  // sarebbe un rosso su una misura che non vale.
  const exitCode: ExitCode = blockers.length > 0 ? 2 : exceeded.length > 0 ? 1 : 0;
  return { exitCode, rows, exceeded, blockers };
}

/**
 * I budget nuovi da una misura nuova, con la regola dichiarata nella baseline.
 *
 * Il PAVIMENTO serve perche' oggi due metriche su tre misurano zero: senza,
 * `--update-baseline` scriverebbe un budget di zero, cioe' una soglia che
 * nessuna run puo' rispettare, e il cancello diventerebbe rumore da spegnere.
 */
export function updatedBudget(
  m: Measurement,
  b: Baseline,
): { dropped_pct: number; worst_gap_ms: number; longtask_ms: number } {
  const one = (key: (typeof METRICS)[number]["key"]): number => {
    const rule = b.update_rule[key];
    if (!rule) return b.budget[key];
    return Math.max(rule.floor, Math.round(m.median[key] * rule.multiplier * 100) / 100);
  };
  return {
    dropped_pct: one("dropped_pct"),
    worst_gap_ms: one("worst_gap_ms"),
    longtask_ms: one("longtask_ms"),
  };
}

/** Lettura difensiva: un JSON valido con la forma sbagliata non e' una measurement. */
export function readMeasurement(path: string): Measurement {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Measurement>;
  if (!raw.median || !raw.witness || typeof raw.calibration_gap_ms !== "number") {
    throw new Error(
      `${path} non ha la forma di una misura (servono median, witness, calibration_gap_ms).`,
    );
  }
  return raw as Measurement;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const update = argv.includes("--update-baseline");
  const fromIndex = argv.indexOf("--from");
  const from = fromIndex >= 0 ? argv[fromIndex + 1] : undefined;
  if (fromIndex >= 0 && !from) {
    console.error("✗ --from vuole un percorso.");
    process.exit(2);
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  // `resolve` e non `join`: con un percorso assoluto `join` lo incollerebbe in
  // coda alla radice del repo, e il file «non esisterebbe» per un motivo finto.
  const outPath = from ? resolve(REPO_ROOT, from) : DEFAULT_OUT;
  let notBefore: Date | undefined;

  if (!from) {
    // Il banco si avvia da solo: il globalSetup di Playwright tira su il server
    // di test isolato, il suo SQLite e la fotografia del bundle. `E2E_PORT` e
    // `TOPICS_E2E_BUNDLE_DIR` passano da qui senza essere toccate, cosi' un
    // worktree o una macchina senza watcher del client restano governabili
    // esattamente come per il resto della suite.
    notBefore = new Date();
    console.log(`▸ misuro ${SPEC_PATH} (banco e2e, ~40s)\n`);
    const run = spawnSync(
      "npx",
      ["playwright", "test", SPEC_PATH, "--reporter=list"],
      {
        cwd: REPO_ROOT,
        stdio: "inherit",
        env: { ...process.env, TOPICS_FLUIDO_OUT: outPath },
      },
    );
    if (run.status !== 0) {
      console.error(
        `\n✗ Il banco non e' arrivato in fondo (uscita ${run.status}).\n` +
          `  Non e' un giudizio sulla fluidita': senza una misura non c'e' niente da giudicare.`,
      );
      process.exit(2);
    }
  }

  if (!existsSync(outPath)) {
    console.error(`✗ Nessuna misura in ${outPath}.`);
    process.exit(2);
  }

  let measurement: Measurement;
  try {
    measurement = readMeasurement(outPath);
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(2);
  }

  console.log(`\nsuperficie     trascritto di una chat (react-virtuoso)`);
  console.log(`testimoni      ${measurement.witness.scroll_span_px}px percorsi, ${measurement.witness.render_churn} cambi di item`);
  console.log(`calibrazione   ${measurement.calibration_gap_ms} ms a riposo su pagina vuota (tetto ${baseline.guards.calibration_gap_ms_ceiling} ms)`);
  if (measurement.jank_injected_ms) {
    console.log(
      `\n⚠ LENTEZZA INIETTATA: ${measurement.jank_injected_ms} ms di blocco ogni 100 ms nel main thread.\n` +
        `  Questa misura serve a vedere il cancello fallire, non a giudicare il repo.`,
    );
  }
  console.log("");

  const verdict = judge(measurement, baseline, notBefore);
  for (const r of verdict.rows) console.log(r);

  if (update) {
    if (verdict.blockers.length > 0) {
      console.error(`\n✗ Non registro una misura che non vale:\n  - ${verdict.blockers.join("\n  - ")}`);
      process.exit(2);
    }
    // UNA REGRESSIONE NON SI REGISTRA COME NUOVA NORMALITA' SENZA DIRLO.
    //
    // Qui il ramo scriveva i budget nuovi e usciva 0 comunque, quindi
    // `--update-baseline` lanciato per abitudine su un albero peggiorato non
    // produceva un rosso: produceva una soglia piu' alta e un verde, cioe' il
    // modo piu' rapido di disarmare questo cancello per sempre. Adesso, se la
    // misura sfora, la baseline si scrive ma l'uscita resta 1: il numero nuovo
    // c'e' e nel diff si vede cosa ha comprato, ma nessuno puo' dire che il
    // giro era verde.
    if (verdict.exceeded.length > 0) {
      console.error(
        `\n⚠ Registro la baseline SU UNA MISURA PEGGIORATA:\n  - ${verdict.exceeded.join("\n  - ")}\n` +
          `  L'uscita resta 1: se il costo e' voluto, il commit deve dirlo.`,
      );
      process.exitCode = 1;
    }
    const next = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, any>;
    next.updated = new Date().toISOString().slice(0, 10);
    next.measured = {
      ...next.measured,
      dropped_pct: measurement.median.dropped_pct,
      worst_gap_ms: measurement.median.worst_gap_ms,
      longtask_ms: measurement.median.longtask_ms,
      median_gap_ms: measurement.median.median_gap_ms ?? next.measured.median_gap_ms,
      calibration_gap_ms: measurement.calibration_gap_ms,
    };
    next.budget = { _: next.budget._, ...updatedBudget(measurement, baseline) };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(
      `\n✓ Baseline aggiornata in ${BASELINE_PATH}.\n` +
        `  Aggiorna a mano anche \`budget_why\`: un numero senza il suo perche' e' un numero\n` +
        `  che il prossimo alzera' di nuovo senza chiederselo.`,
    );
    process.exit(0);
  }

  if (verdict.exitCode === 2) {
    console.error(`\n✗ MISURA NON UTILIZZABILE:\n  - ${verdict.blockers.join("\n  - ")}`);
    console.error(`\nNessun giudizio sulla fluidita': la misura non parla del prodotto.`);
    process.exit(2);
  }

  if (verdict.exitCode === 1) {
    console.error(`\n✗ La superficie ha perso fluidita':\n  - ${verdict.exceeded.join("\n  - ")}`);
    console.error(
      `\nDove guardare: un long task che cresce dice lavoro sul main thread dentro lo\n` +
        `scorrimento (un layout sincrono, un effetto che rimisura, una lista non memoizzata).\n` +
        `Se invece il rallentamento e' deliberato, alza il numero in ${BASELINE_PATH}\n` +
        `NELLO STESSO commit, con il perche' in \`budget_why\`, cosi' il diff mostra cosa ha comprato.`,
    );
    process.exit(1);
  }

  console.log("\n✓ Scorrimento dentro il budget.");
  process.exit(0);
}
