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
 * mancavano `check:occlusion`, `check:previews` e `check:demo`. Un elenco che
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
 */
import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "../..");
const WORKFLOW_DIR = join(REPO_ROOT, ".github/workflows");

/**
 * I prefissi che dichiarano «questo non e' un cancello del codice»: leggono il
 * database vivo, la macchina, o il disco di questa postazione. Nessuno di loro
 * puo' stare in un workflow, dove niente di tutto cio' esiste.
 */
const REFERTO_PREFIXES = ["report:", "probe:", "measure:", "bench:"];

/**
 * I `check:*` che nessuno esegue, e il motivo. Non e' un condono: e' il posto
 * dove il motivo va scritto, e il test qui sotto pretende che sia ancora vero
 * (una voce che nel frattempo E' stata cablata fa rosso quanto un orfano).
 */
const MOTIVI: Record<string, string> = {
  "check:lockfile":
    "versione «una botta sola» per l'umano (root, client, landing). In CI gli stessi tre " +
    "lockfile sono gia' coperti dai due install piu' il passo landing/ dedicato.",
  "check:contrast": "gira su landing/dist, un sito gia' costruito che nessun workflow costruisce.",
  "check:field": "gira su landing/dist, un sito gia' costruito che nessun workflow costruisce.",
  "check:painted": "gira su landing/dist, un sito gia' costruito che nessun workflow costruisce.",
  "check:landing": "gira su landing/dist, un sito gia' costruito che nessun workflow costruisce.",
  "check:copy": "gira su landing/dist, un sito gia' costruito che nessun workflow costruisce.",
  "check:ink":
    "e' un cancello VERO del codice — misura i millisecondi dal click all'inchiostro sulle tre " +
    "azioni piu' frequenti — ma vuole un bundle del client COSTRUITO e il server di test in " +
    "piedi, cioe' la stessa attrezzatura degli e2e, non quella dei controlli statici. Metterlo " +
    "fra i guard rails li farebbe passare da secondi a minuti su ogni push. Gira a mano " +
    "(`bun run check:ink`), e ha la sua leva di falsificazione: `--stall 300` rende l'app " +
    "davvero lenta e il cancello DEVE diventare rosso. Il posto dove cablarlo, quando ci sara' " +
    "un lavoro e2e in CI, e' li' — non qui.",
  "check:occlusion":
    "e' un cancello VERO del codice, ma vuole un WebKit di Playwright e un bundle costruito: " +
    "gira a mano, ed e' anche l'attrezzo che registra la clip di consegna (--video).",
  "check:previews":
    "stessa specie di report:landed: misura lo STATO DELLA BOARD, non il codice. Legge " +
    "data/topics.db e ~/.openclaw/media/task-previews, che su un checkout di CI non esistono. " +
    "Il nome dice check: ma e' un referto — se un giorno si tocca quello script, il prefisso " +
    "e' la prima cosa da correggere.",
};

/** Gli script di package.json, per nome. */
function scripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

/**
 * Toglie i commenti YAML: da un `#` a inizio riga o preceduto da spazio fino a
 * fine riga.
 *
 * PERCHE'. Un workflow ESEGUE nel blocco `run:` e SPIEGA nei commenti, e la
 * differenza e' tutta qui. Senza questo passaggio il primo commento che nomina
 * un comando lo fa contare come eseguito — e' successo subito, al primo giro:
 * il commento che ho aggiunto in `ci.yml` per dire «non aggiungere
 * `report:landed` qui» contiene la stringa `bun run report:landed --json` come
 * indicazione a chi legge, e il test lo ha denunciato come intruso. Un
 * controllo che punisce la propria documentazione insegna a non documentare.
 *
 * PERCHE' CONTA LE VIRGOLETTE, e non e' pignoleria. Questo passaggio non
 * aggiunge testo: ne TOGLIE. Quindi ogni suo eccesso va nella direzione che non
 * si vede — un comando cancellato per sbaglio non e' un falso allarme, e'
 * un'invocazione che sparisce, e il test qui sotto diventa verde su un workflow
 * che quel comando lo esegue davvero. Con un taglio al primo `#` della riga,
 *
 *     - run: echo "step #1" && bun run report:landed
 *
 * resta `- run: echo "step`, e il referto entra in CI senza che nessuno lo
 * denunci (misurato: il cancello usciva 0 su quella riga). Il `#` apre un
 * commento solo se e' FUORI da una stringa, quindi lo stato delle virgolette va
 * seguito. Inchiodato in fondo al file, riga per riga.
 */
function stripYamlComments(src: string): string {
  return src
    .split(/\r?\n/)
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i]!;
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === "'" || c === '"') {
          quote = c;
        } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
}

/** Ogni workflow, come `nome → sorgente ESEGUIBILE` (commenti tolti). */
function workflows(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(WORKFLOW_DIR).sort()) {
    if (!f.endsWith(".yml") && !f.endsWith(".yaml")) continue;
    out[f] = stripYamlComments(readFileSync(join(WORKFLOW_DIR, f), "utf-8"));
  }
  return out;
}

/**
 * `run <nome>` con un confine vero in coda. Senza il confine, `check:deadcode`
 * si troverebbe dentro `check:deadcode-blindspots` e un orfano passerebbe
 * appoggiandosi al nome di un altro.
 *
 * Cerca `run` seguito dal nome, quindi la DEFINIZIONE di uno script non conta
 * come invocazione: `"check:any": "bun run scripts/check-any.ts"` non contiene
 * `run check:any`.
 */
function invokes(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\brun\\s+${escaped}(?![\\w:.-])`).test(source);
}

/** Chi esegue `name`: workflow che lo lanciano + altri script che lo lanciano. */
function invokers(name: string, all: Record<string, string>, wf: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [file, src] of Object.entries(wf)) if (invokes(src, name)) out.push(`.github/workflows/${file}`);
  for (const [key, cmd] of Object.entries(all)) if (key !== name && invokes(cmd, name)) out.push(`package.json:${key}`);
  return out;
}

describe("nomi degli script: cancelli e referti", () => {
  it("ogni check:* e' eseguito da qualcuno, o ha scritto perche' no", () => {
    const all = scripts();
    const wf = workflows();
    const orfani: string[] = [];
    for (const name of Object.keys(all).sort()) {
      if (!name.startsWith("check:")) continue;
      if (invokers(name, all, wf).length > 0) continue;
      if (MOTIVI[name]) continue;
      orfani.push(
        `${name}  — definito in package.json e lanciato da NESSUNO.\n` +
          `      Un check che nessuno esegue non protegge: fa credere che la classe di difetti\n` +
          `      sia coperta. O lo cabli in .github/workflows/ci.yml, o scrivi il motivo in\n` +
          `      MOTIVI qui in tests/unit/check-scripts-are-wired.test.ts. Se misura lo stato\n` +
          `      della board e non il codice, il nome giusto e' report:* (vedi report:landed).`,
      );
    }
    expect(orfani.join("\n")).toBe("");
  });

  it("nessuna voce di MOTIVI e' scaduta", () => {
    // Una deroga sopravvissuta a cio' che scusava e' peggio di nessuna deroga:
    // dice che un check non gira mentre invece gira, e il prossimo che legge si
    // fida della riga sbagliata.
    const all = scripts();
    const wf = workflows();
    const scadute: string[] = [];
    for (const [name, motivo] of Object.entries(MOTIVI)) {
      if (!all[name]) {
        scadute.push(`${name}: non esiste piu' in package.json, togli la riga da MOTIVI`);
        continue;
      }
      const chi = invokers(name, all, wf);
      if (chi.length > 0) scadute.push(`${name}: ora e' cablato (${chi.join(", ")}), togli la riga da MOTIVI`);
      if (motivo.trim().length < 20) scadute.push(`${name}: il motivo e' troppo corto per essere un motivo`);
    }
    expect(scadute.join("\n")).toBe("");
  });

  it("nessun referto entra in un workflow", () => {
    const all = scripts();
    const wf = workflows();
    const intrusi: string[] = [];
    for (const name of Object.keys(all).sort()) {
      if (!REFERTO_PREFIXES.some((p) => name.startsWith(p))) continue;
      for (const [file, src] of Object.entries(wf)) {
        if (!invokes(src, name)) continue;
        intrusi.push(
          `${name} e' invocato da .github/workflows/${file}.\n` +
            `      I prefissi ${REFERTO_PREFIXES.join(" ")} dichiarano un REFERTO: misurano il database\n` +
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
