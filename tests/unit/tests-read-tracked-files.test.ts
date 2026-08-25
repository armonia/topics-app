/**
 * UN TEST CHE LEGGE UN FILE NON TRACCIATO PASSA SOLO SU QUESTA MACCHINA.
 *
 * ── Il guasto, con la data ──────────────────────────────────────────────────
 * `tests/unit/destinazioni.test.ts` apre `docs/destinazioni.md` con un
 * `readFileSync` a livello di MODULO. Il documento combaciava con `docs/*` in
 * `.gitignore` e non era mai stato aggiunto: sul disco di chi l'aveva scritto
 * c'era, su un checkout pulito no. Su CI il file di test non arrivava nemmeno a
 * dichiarare i suoi casi — esplodeva in import con `ENOENT` — quindi
 * `test:unit` usciva 1, il job `check` era rosso, e `auto-bump.yml` (che parte
 * su `workflow_run` e pretende `conclusion == success`) restava `skipped`.
 *
 * Misurato il 2026-08-18: CI rossa dal 17/08, **105 commit senza un installer**,
 * ultimo tag `tauri-v2.2.158`. Un documento ignorato aveva smesso di far uscire
 * il prodotto, e in locale era tutto verde.
 *
 * ── Perche' guarda le LETTURE e non i letterali ─────────────────────────────
 * La prima versione prendeva ogni stringa che somigliasse a un percorso. Su
 * questo albero produceva tre righe, tutte false: un path sintetico dentro una
 * fixture (`put("client/src/app.tsx")`), un argomento a una funzione pura
 * (`isUserVisibleFile("./client/src/App.tsx")`) e una menzione dentro un
 * COMMENTO. Un cancello che grida su cio' che non e' una lettura e' un cancello
 * che si impara a saltare — la lezione e' scritta anche in `check-security.ts`.
 *
 * Quindi guarda solo i letterali passati a una funzione che APRE un file, i
 * commenti li toglie prima, e il confronto e' sensibile alle maiuscole: su
 * macOS `client/src/app.tsx` «esiste» anche se il file si chiama `App.tsx`, e
 * su Linux no. Un letterale che non corrisponde a nessun file vero non e'
 * affar suo: puo' essere una fixture costruita a runtime.
  * @covers GATE-09
 */
import { describe, test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");

/**
 * Cartelle che sul disco esistono e nel repo NON devono esserci: sono prodotte,
 * non scritte. Un test che le legge le ha appena create o le ricrea da se'.
 */
const GENERATE = new Map<string, string>([
  ["node_modules/", "dipendenze installate"],
  ["public/", "il bundle del client, prodotto da `bun run build:client`"],
  ["dist/", "artefatti di build"],
  ["test-results/", "esiti e video di Playwright, prodotti dalla passata"],
  ["data/", "il database vivo"],
  ["uploads/", "allegati caricati a runtime"],
  ["videos/", "registrazioni prodotte dalla suite"],
  ["landing/dist/", "il sito costruito"],
  ["graphify-out/", "uscita di uno strumento"],
  ["checkpoints/", "stato di sessione, non sorgente"],
  ["ai-bridge/", "store del broker, scritto a runtime"],
  ["journal/", "diario scritto a runtime"],
  ["messages/", "scritto a runtime"],
  ["spec-flow/", "clone di un repo separato (armonia/spec-flow), assente da ogni checkout"],
  ["certs/", "certificati locali, non vanno in un repo pubblico"],
]);

/** Le funzioni che APRONO un file. Un letterale altrove e' un dato, non una lettura. */
const LETTORI = "readFileSync|readFile|existsSync|statSync|lstatSync|createReadStream|readdirSync|Bun\\.file";

/**
 * I percorsi letterali passati a un lettore, anche attraverso un `resolve`/`join`
 * (`readFileSync(resolve(ROOT, "docs/x.md"))` e' la forma usata in tutto il repo).
 * Un `readFileSync(join(ROOT, variabile))` non porta letterali e viene ignorato:
 * quel percorso si compone a runtime e non e' decidibile qui.
 */
export function lettureLetterali(sorgente: string): string[] {
  const senzaCommenti = sorgente
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  const re = new RegExp(
    `(?:${LETTORI})\\s*\\(\\s*(?:(?:resolve|join)\\s*\\([^)]*?,\\s*)?["'\`]([^"'\`\\n]+)["'\`]`,
    "g",
  );
  const out: string[] = [];
  for (const m of senzaCommenti.matchAll(re)) {
    let p = m[1]!;
    if (p.startsWith("/") || p.startsWith("http") || p.includes("${")) continue;
    p = p.replace(/^\.\//, "");
    if (p.startsWith("..")) continue; // relativo al file, non alla radice: non decidibile
    if (!p.includes("/")) continue;
    out.push(p);
  }
  return out;
}

function tracciati(): Set<string> {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  return new Set(out.split("\0").filter((p) => p.length > 0));
}

function fileDiTest(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "*.test.ts", "*.test.tsx", "*.spec.ts"], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter((p) => p.length > 0);
}

describe("un test non legge file che il repo non ha", () => {
  const tracked = tracciati();
  const tests = fileDiTest();

  test("l'estrattore riconosce la forma che ha rotto la CI", () => {
    // SENZA QUESTO il cancello puo' diventare verde perche' non guarda piu'
    // niente: un cambio di regex che smette di prendere `readFileSync` non
    // farebbe fallire nessun altro caso di questo file. Qui c'e' la forma
    // esatta di destinazioni.test.ts, piu' i tre falsi positivi che la prima
    // versione produceva e che NON devono tornare.
    const veri = lettureLetterali(`
      const DOC = readFileSync(resolve(RADICE, "docs/destinazioni.md"), "utf8");
      const P = await Bun.file("scripts/security-baseline.json").text();
    `);
    expect(veri).toEqual(["docs/destinazioni.md", "scripts/security-baseline.json"]);

    const falsi = lettureLetterali(`
      // legge .claude/settings.local.json quando serve
      /* nota: client/src/app.tsx */
      put("client/src/app.tsx");
      expect(isUserVisibleFile("./client/src/App.tsx")).toBe(true);
      readFileSync(join(ROOT, variabile));
    `);
    expect(falsi).toEqual([]);
  });

  test("l'elenco dei file di test non e' vuoto (guardia contro un verde a vuoto)", () => {
    expect(tests.length).toBeGreaterThan(100);
    expect(tracked.size).toBeGreaterThan(1000);
  });

  test("ogni file del repo APERTO da un test e' tracciato", () => {
    const colpevoli: string[] = [];
    for (const f of tests) {
      let src: string;
      try { src = readFileSync(join(ROOT, f), "utf8"); } catch { continue; }
      for (const p of new Set(lettureLetterali(src))) {
        if (tracked.has(p)) continue;
        if ([...GENERATE.keys()].some((g) => p.startsWith(g))) continue;
        const abs = join(ROOT, p);
        if (!existsSync(abs)) continue;
        try { if (!statSync(abs).isFile()) continue; } catch { continue; }
        colpevoli.push(`${f} apre ${p}: esiste sul disco ma NON e' tracciato`);
      }
    }
    expect(
      colpevoli,
      "Un file che c'e' solo qui rende il test verde in locale e rosso — o esploso in " +
        "import — su un checkout pulito. O si traccia il file (allowlist in .gitignore se " +
        "combacia con una regola, con la ragione accanto) o il test smette di dipenderne.",
    ).toEqual([]);
  });
});
