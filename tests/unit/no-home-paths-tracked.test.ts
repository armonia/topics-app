import { describe, test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { readFileSync, statSync } from "fs";
import { homedir } from "os";
import { resolve, join } from "path";

/**
 * Nessun file tracciato contiene il percorso della home di chi lo committa.
 *
 * `armonia/topics-app` è un repo PUBBLICO. Quando lo è diventato (2026-06-02)
 * l'audit ha tolto `.planning/` proprio per questo: 299 documenti interni che
 * portavano ~314 percorsi `/Users/<nome>`. Il nome utente non è una credenziale,
 * ma è un dato personale che finisce indicizzato, e insieme al percorso racconta
 * la disposizione della macchina di chi lavora.
 *
 * È rientrato dalla finestra. Al 2026-08-10 quattro file tracciati ne portavano
 * 48: `scripts/board-vs-chat.arms.json` (24) e i tre
 * `docs/board-vs-chat/t1-appaiato-*.pair.json` (8 ciascuno), tutti nel campo
 * `transcriptPath` — cioè registri di MISURA, che nascono su una macchina sola e
 * per questo si portano dietro il suo percorso senza che nessuno lo scriva
 * apposta. Non erano ancora pubblici: `main` non è spinto da 112 commit. Questo
 * test è il motivo per cui non lo diventeranno.
 *
 * LA FORMA GIUSTA È `~/…`, non un path cancellato: `board-vs-chat.ts` espande la
 * tilde con `expandHome()`, quindi il registro resta RISOLVIBILE sulla macchina
 * dove i transcript esistono davvero, e altrove degrada come già faceva («transcript
 * assente», nota nel referto). Anonimizzare non costa la prova.
 *
 * PERCHÉ IL NOME NON È SCRITTO QUI. Il test cerca `homedir()` di CHI ESEGUE, non
 * una stringa costante: scriverla dentro un test del repo pubblico sarebbe la
 * stessa fuga che il test vuole impedire, in un file in più. Nemmeno come
 * ESEMPIO in un commento — questa riga lo faceva, ed è stata l'unica occorrenza
 * del nome utente in tutto l'albero tracciato quando il cancello gemello
 * (`no-personal-data-tracked.test.ts`) è andato a cercarla. Un cancello che
 * viola la propria regola per spiegarla insegna a violarla.
 * Come effetto secondario il cancello vale per chiunque: protegge la home di chi
 * committa, quella che sia.
 */

const ROOT = resolve(import.meta.dir, "..", "..");
const HOME = homedir();

/** Solo file di testo che un umano scrive o che un attrezzo genera: i binari
 *  non si leggono come stringhe e i lockfile citano percorsi di cache. */
const TESTABILE = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|sql|sh|yml|yaml|toml|css|html|rs|plist)$/;

/** Esenzioni, ognuna con la sua ragione. */
const ESENTI = new Set<string>([
  // Questo file: contiene `homedir()` come CODICE, non come dato — e il
  // confronto qui sotto lo troverebbe solo se la home comparisse letterale.
  "tests/unit/no-home-paths-tracked.test.ts",
]);

function tracciati(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter((p) => p.length > 0 && TESTABILE.test(p) && !ESENTI.has(p));
}

describe("nessun percorso di home in un file tracciato", () => {
  const files = tracciati();

  test("l'elenco dei file tracciati non è vuoto (guardia contro un verde a vuoto)", () => {
    // Se `git ls-files` fallisse o il filtro non matchasse più niente, il test
    // sotto passerebbe misurando zero file: il modo più comune in cui un
    // cancello smette di mordere senza diventare rosso.
    expect(files.length).toBeGreaterThan(500);
  });

  /**
   * IL PATH NON BASTA. La prima versione di questo cancello cercava solo
   * `homedir()` letterale, ed è passata verde su sette file che il nome utente
   * ce l'avevano lo stesso in un'altra grafia: url-encoded
   * (`%2FUsers%2F<nome>%2F…`, dentro una chiave di pin), nello slug con cui
   * Claude nomina le cartelle di progetto (`-Users-<nome>-Projects-…`) e in
   * prosa dentro tre documenti openspec. Cercare il TOKEN le prende tutte,
   * perché è la parte personale in ognuna delle tre.
   *
   * Il nome si ricava da `basename(homedir())`, mai scritto: vale la stessa
   * ragione di sopra. Sotto i 4 caratteri il controllo si spegne — un utente
   * chiamato `dev` o `ci` produrrebbe solo falsi positivi, e un cancello che
   * grida sempre è un cancello che si impara a ignorare.
   */
  const utente = HOME.split("/").filter(Boolean).pop() ?? "";

  test("il nome utente non compare in nessun file tracciato, in nessuna grafia", () => {
    if (utente.length < 4) return; // guardia sui nomi generici, vedi sopra
    const colpevoli: string[] = [];
    for (const rel of files) {
      const abs = join(ROOT, rel);
      try {
        const st = statSync(abs);
        if (!st.isFile() || st.size > 8 * 1024 * 1024) continue;
      } catch {
        continue;
      }
      let body: string;
      try {
        body = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const n = body.split(utente).length - 1;
      if (n > 0) colpevoli.push(`${rel} (${n})`);
    }
    expect(
      colpevoli,
      "questi file tracciati contengono il tuo nome utente (anche url-encoded, o nello slug -Users-<nome>-…), e il repo è PUBBLICO. Sostituiscilo con un nome neutro o con \"~/\".",
    ).toEqual([]);
  });

  test("la home di chi esegue non compare in nessuno di essi", () => {
    const colpevoli: string[] = [];
    for (const rel of files) {
      const abs = join(ROOT, rel);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue; // tracciato ma assente dal disco (checkout sparso)
      }
      if (!st.isFile() || st.size > 8 * 1024 * 1024) continue;
      let body: string;
      try {
        body = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (!body.includes(HOME)) continue;
      const n = body.split(HOME).length - 1;
      colpevoli.push(`${rel} (${n})`);
    }
    expect(
      colpevoli,
      `questi file tracciati contengono il percorso della tua home, e il repo è PUBBLICO. Sostituiscilo con "~/" (chi lo legge lo espande: vedi expandHome in scripts/board-vs-chat.ts) oppure togli il file dal tracciamento.`,
    ).toEqual([]);
  });
});
