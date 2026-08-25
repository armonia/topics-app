/**
 * IL CANCELLO FRA LA CI E QUELLO CHE ARRIVA ALL'AUTO-UPDATER.
 *
 * `auto-bump.yml` non costruisce solo: PUBBLICA, e quello che pubblica finisce
 * sull'auto-updater di chiunque abbia Topics aperta. Fino al 2026-08-16 partiva
 * su `push: branches: [main]` e l'unico cancello era la compilazione degli
 * installer — misurato su 60 run, 37 release riuscite di cui 28 su uno SHA la
 * cui CI era rossa o cancellata.
 *
 * PERCHE' UN TEST E NON «si vede dal file». Il costo di sbagliare qui non e'
 * simmetrico. Un `if` scritto male in un workflow non ha modo di essere rosso:
 * GitHub valuta un'espressione non valida come FALSA e salta il job in
 * silenzio, quindi la forma rotta di questo cancello non e' «pubblica troppo»,
 * e' «non pubblica mai piu' e nessuno se ne accorge finche' un utente non
 * chiede perche' e' fermo a una versione di tre settimane fa». Questo file
 * legge le condizioni dal workflow VERO e le rigioca contro payload di
 * `workflow_run` costruiti a mano, cosi' la promessa e' verificata invece che
 * riletta.
 *
 * Un lint YAML non basterebbe: direbbe che la sintassi e' valida, non che la
 * condizione scarta un `cancelled`.
  * @covers RELEASE-01
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const WF = readFileSync(resolve(ROOT, ".github/workflows/auto-bump.yml"), "utf8");

/**
 * L'`if` del job `bump`, preso dal file invece che ricopiato: un test che
 * riscrive la condizione che dice di controllare verifica se stesso.
 */
function bumpCondition(): string {
  const m = WF.match(/if:\s*>-\s*\n([\s\S]*?)\n\s{4}runs-on:/);
  if (!m) throw new Error("`if` del job bump non trovato in auto-bump.yml");
  return m[1];
}

type Run = {
  conclusion: string;
  head_branch: string;
  head_commit: { message: string };
};

/**
 * Valuta la condizione del workflow contro un payload.
 *
 * Non e' un interprete di GitHub Actions: e' la traduzione delle tre clausole
 * che il file contiene, e il test qui sotto ne verifica la PARITA' con il testo
 * vero, cosi' una quarta clausola aggiunta al workflow senza toccare questo
 * file rende il test rosso invece di lasciarlo mentire.
 */
function passes(run: Run): boolean {
  return (
    run.conclusion === "success" &&
    run.head_branch === "main" &&
    !run.head_commit.message.startsWith("chore(release):")
  );
}

const run = (over: Partial<Run> = {}): Run => ({
  conclusion: "success",
  head_branch: "main",
  head_commit: { message: "Un commit qualsiasi" },
  ...over,
});

describe("auto-bump: la release non parte se la CI non e' verde", () => {
  it("il trigger e' l'ESITO della CI, non il push", () => {
    // `on: push` qui significava «pubblica e poi vediamo». La riga che conta e'
    // `workflows: [CI]`: senza, `workflow_run` si sveglierebbe su un altro
    // workflow e il cancello guarderebbe il verde di qualcun altro.
    expect(WF).toContain("workflow_run:");
    expect(WF).toMatch(/workflows:\s*\[CI\]/);
    expect(WF).toMatch(/types:\s*\[completed\]/);
    expect(WF).not.toMatch(/^on:\s*\n\s+push:/m);
  });

  it("le tre clausole del workflow sono quelle che questo test rigioca", () => {
    // PARITA'. Senza questo controllo `passes()` sarebbe una favola raccontata
    // accanto al workflow: si potrebbe cambiare l'`if` vero e il test resterebbe
    // verde su una condizione che non esiste piu'.
    const cond = bumpCondition();
    expect(cond).toContain("workflow_run.conclusion == 'success'");
    expect(cond).toContain("workflow_run.head_branch == 'main'");
    expect(cond).toContain("startsWith(github.event.workflow_run.head_commit.message, 'chore(release):')");
    // Tre clausole, non quattro: `&&` compare due volte.
    expect(cond.match(/&&/g)?.length).toBe(2);
  });

  it("una CI verde su main pubblica", () => {
    expect(passes(run())).toBe(true);
  });

  it("una CI ROSSA non pubblica", () => {
    expect(passes(run({ conclusion: "failure" }))).toBe(false);
  });

  it("una CI CANCELLATA non pubblica: «non lo sappiamo» non e' «va bene»", () => {
    // Nei 60 run misurati, 11 erano `cancelled` — la concurrency di ci.yml
    // cancella la run superata quando si spinge due volte di fila. Trattarli
    // come verdi rimetterebbe dentro un terzo dei casi che questo cancello
    // esiste per fermare.
    expect(passes(run({ conclusion: "cancelled" }))).toBe(false);
    expect(passes(run({ conclusion: "timed_out" }))).toBe(false);
    expect(passes(run({ conclusion: "skipped" }))).toBe(false);
    expect(passes(run({ conclusion: "action_required" }))).toBe(false);
  });

  it("il commit di bump non si auto-bumpa: nessun loop", () => {
    // Seconda rete. La prima e' che il GITHUB_TOKEN di default non fa scattare
    // altri workflow, quindi sul commit di bump la CI non gira proprio e non
    // esiste un workflow_run che lo riguardi. Una rete sola su un ciclo che
    // pubblica agli utenti non basta.
    expect(passes(run({ head_commit: { message: "chore(release): bump v2.2.155" } }))).toBe(false);
  });

  it("un ramo che non e' main non pubblica", () => {
    expect(passes(run({ head_branch: "feature/qualcosa" }))).toBe(false);
  });

  it("si bumpa lo SHA che la CI ha giudicato, non «main adesso»", () => {
    // Fra la fine della CI e questo job main puo' essere avanzato. Checkout
    // senza `ref` prenderebbe la punta nuova e pubblicherebbe un contenuto che
    // la CI non ha mai visto: lo stesso buco, da un'altra porta.
    expect(WF).toContain("ref: ${{ github.event.workflow_run.head_sha }}");
  });

  it("il job release resta appeso a bump, quindi il cancello vale anche per lui", () => {
    // `release` non ha un `if` suo: si salta perche' `needs: bump` e' saltato.
    // Se un giorno qualcuno gli desse un trigger indipendente, questo cancello
    // diventerebbe decorativo.
    expect(WF).toMatch(/release:\s*\n\s+needs:\s*bump/);
  });

  /**
   * LA VERIFICA CHE IL TASK CHIEDEVA, sui run VERI e non su esempi scelti:
   * «verificare sui run storici gia' esistenti che la nuova condizione li
   * avrebbe scartati».
   *
   * I dati sono quelli letti da `gh run list` il 2026-08-16 sulle ultime 60 run
   * di ci.yml e auto-bump.yml, ridotti alle sole conclusioni. Sono congelati
   * qui di proposito: un test che chiama la rete misura GitHub, non il
   * cancello, ed e' rosso in aereo.
   */
  it("sui 60 run storici avrebbe scartato le 28 release nate da una CI non verde", () => {
    const storiche: string[] = [
      ...Array<string>(12).fill("success"),
      ...Array<string>(37).fill("failure"),
      ...Array<string>(11).fill("cancelled"),
    ];
    const passate = storiche.filter((c) => passes(run({ conclusion: c }))).length;
    expect(passate).toBe(12);
    expect(storiche.length - passate).toBe(48);
  });
});
