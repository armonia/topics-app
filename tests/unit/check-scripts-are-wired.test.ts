/**
 * Due domande sui nomi degli script, che sono la sola cosa che si legge prima
 * di decidere se una barra e' verde.
 *
 *   1. ogni `check:*` o e' ESEGUITO da qualcuno, o ha scritto perche' no;
 *   2. nessun REFERTO (`report:` `probe:` `measure:` `bench:`) entra in un
 *      workflow.
 *
 * PERCHE' ESISTE LA PRIMA. Il commento in `.github/workflows/ci.yml:85-91` lo
 * dice gia' a parole: «uno script di check che nessuno esegue non e' una
 * protezione: e' la sua imitazione, e costa di piu' di non averlo perche' fa
 * credere che la classe di difetti sia coperta». Quel commento e' stato scritto
 * la terza volta che il repo trovava la stessa cosa, e sotto si e' messo a
 * elencare i `check:*` che restano fuori dalla CI «ognuno per un motivo che
 * vale la pena scrivere». L'elenco a mano si e' scollato subito: al 13/08
 * mancavano `check:occlusion`, `check:previews` (oggi `report:previews`) e
 * `check:demo`. Un elenco che
 * si aggiorna a mano racconta lo stato di quando lo hanno scritto; questo lo
 * DERIVA a ogni run, quindi o e' completo o e' rosso.
 *
 * PERCHE' ESISTE LA SECONDA. `report:landed` (scripts/check-done-landed.ts) si
 * chiamava `check:landed`, e col prefisso dei sei cancelli che la CI esegue
 * sembrava una barra da tenere verde. Non puo' esserlo: legge lo STATO DELLA
 * BOARD da `data/topics.db`, che e' in .gitignore:174 e su un clone pulito non
 * esiste — lo script esce **2** senza guardare niente. E i checkout che
 * ispeziona arrivano anche da `~/.openclaw/workspace`, cioe' da altri progetti:
 * il 13/08, 2 dei suoi 4 debiti stavano in altri due repo della postazione. Un
 * cancello che diventa rosso per un ramo di un altro repo, o per un file che
 * nel repo non ci sara' mai, non e' un cancello: e' un referto. Il prefisso e'
 * il posto dove si dice quale delle due cose e', e questa e' la riga che
 * impedisce a un referto di rientrare da una porta di servizio.
 *
 * Nessuno dei due controlli tocca il disco oltre a `package.json` e ai
 * workflow, ne' un database, ne' la rete: le stesse cose che i referti fanno e
 * che li tengono fuori dalla CI.
 * @covers GATE-10
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  REPORT_PREFIXES,
  WORKFLOW_DIR,
  invokers,
  invokes,
  orphanReport,
  scripts,
  stripYamlComments,
  workflows,
} from "../../scripts/check-gates-orfani";

describe("nomi degli script: cancelli e referti", () => {
  it("ogni check:* e' eseguito da qualcuno, o ha scritto perche' no", () => {
    expect(orphanReport().undeclared.join("\n")).toBe("");
  });

  it("nessuna voce di REASONS e' scaduta", () => {
    expect(orphanReport().expired.join("\n")).toBe("");
  });

  it("a reason that names a file names an EXISTING one", () => {
    expect(orphanReport().brokenPaths.join("\n")).toBe("");
  });

  it("nessun referto entra in un workflow", () => {
    const all = scripts();
    const wf = workflows();
    const intrusi: string[] = [];
    for (const name of Object.keys(all).sort()) {
      if (!REPORT_PREFIXES.some((p) => name.startsWith(p))) continue;
      for (const [file, src] of Object.entries(wf)) {
        if (!invokes(src, name)) continue;
        intrusi.push(
          `${name} e' invocato da .github/workflows/${file}.\n` +
            `      I prefissi ${REPORT_PREFIXES.join(" ")} dichiarano un REFERTO: misurano il database\n` +
            `      vivo, la macchina o il disco di questa postazione, cose che su un checkout di CI\n` +
            `      non ci sono. report:landed, per dirne uno, esce 2 senza data/topics.db\n` +
            `      (.gitignore:174). In un workflow sarebbe rosso per sempre, e rosso per un motivo\n` +
            `      che col codice non c'entra.`,
        );
      }
    }
    expect(intrusi.join("\n")).toBe("");
  });

  it("guarda davvero dentro package.json e i workflow", () => {
    // Senza questo, un glob sbagliato renderebbe i tre test qui sopra verdi per
    // sempre: zero workflow letti significa zero invocazioni trovate, cioe'
    // tutti orfani (ma anche tutti scusabili) e zero intrusi.
    const all = scripts();
    const wf = workflows();
    expect(Object.keys(wf)).toContain("ci.yml");
    expect(Object.keys(all).filter((n) => n.startsWith("check:")).length).toBeGreaterThan(10);
    // I sei cancelli statici che la CI esegue davvero: se il matcher smettesse
    // di vederli, «orfano» perderebbe ogni significato.
    for (const cablato of ["check:any", "check:nul", "check:emdash", "check:deadcode", "check:eslint-disable", "check:test-skips"]) {
      expect(invokers(cablato, all, wf)).toContain(".github/workflows/ci.yml");
    }
    // E il confine in coda al nome funziona: `check:deadcode` non deve
    // spacciarsi per `check:deadcode-blindspots` (e viceversa).
    expect(invokes("bun run check:deadcode-blindspots", "check:deadcode")).toBe(false);
    expect(invokes("bun run check:deadcode", "check:deadcode")).toBe(true);
    // La definizione di uno script non e' una sua invocazione.
    expect(invokes("bun run scripts/check-any.ts", "check:any")).toBe(false);

    // ESEGUIRE contro NOMINARE. Il commento che spiega perche' un referto non
    // va cablato contiene per forza il suo nome: se contasse, il test
    // denuncerebbe la propria documentazione (successo davvero, primo giro).
    const commentato = stripYamlComments("      # non aggiungere `bun run report:landed --json` qui\n");
    expect(invokes(commentato, "report:landed")).toBe(false);
    // Ma il passo VERO conta, commento in coda compreso.
    expect(invokes(stripYamlComments("        run: bun run report:landed  # temporaneo\n"), "report:landed")).toBe(true);
    // E il commento in coda non nasconde il comando che lo precede.
    expect(invokes(stripYamlComments("        run: bun run check:any # nota\n"), "check:any")).toBe(true);
    // Un `#` DENTRO una stringa non apre un commento. Senza questo, togliere i
    // commenti cancella il comando che segue e il referto entra in CI muto:
    // misurato, il cancello usciva 0 su questa riga esatta.
    expect(invokes(stripYamlComments('          echo "step #1" && bun run report:landed\n'), "report:landed")).toBe(
      true,
    );
    expect(invokes(stripYamlComments("          echo 'a # b' && bun run check:any\n"), "check:any")).toBe(true);
    // Ma le virgolette non devono resuscitare un commento vero: qui il `#` e'
    // fuori da ogni stringa, anche se sulla riga di virgolette ce n'erano.
    expect(invokes(stripYamlComments('        run: echo "ciao" # bun run report:landed\n'), "report:landed")).toBe(
      false,
    );
    // Il file vero di questo repo: `ci.yml` NOMINA report:landed in un commento
    // e non lo esegue. Se un giorno lo eseguisse, e' il test qui sopra a dirlo.
    expect(readFileSync(join(WORKFLOW_DIR, "ci.yml"), "utf-8")).toContain("report:landed");
    expect(invokes(wf["ci.yml"]!, "report:landed")).toBe(false);
  });
});
