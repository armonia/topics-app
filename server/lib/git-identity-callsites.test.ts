import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SERVER = join(import.meta.dir, "..");

/**
 * Chi SCRIVE un commit dal server deve passare per `gitEnvFor`.
 *
 * `tests/unit/e2e-git-identity.test.ts` sorveglia la stessa regola per le SPEC,
 * dove l'identità si passa con `-c`. Questo banco copre l'altra metà, che quel
 * test non poteva vedere: il codice di PRODOTTO, dove a lanciare git è il
 * server e l'identità arriva dall'ambiente (`gitEnvFor`, vedi `lib/git-identity.ts`
 * per il perché delle variabili invece di `-c`).
 *
 * La lezione è già stata pagata due volte. Il 15/08 `services/task-automerge.ts`
 * moriva sul runner con «empty ident name … not allowed» ed exit 128, e la card
 * raccontava una storia falsa. Il fix è nato lì e lì è rimasto: il 16/08 la
 * nightly era rossa su FILE-17 per lo STESSO motivo, in un endpoint diverso
 * (`routes/files.ts`, `POST /api/git/commit`) che nessuno aveva collegato.
 *
 * Un fix applicato a una call-site sola non è un fix, è un precedente. Questo
 * banco fa la domanda a tutte insieme, costa millisecondi e gira in
 * `bun run test:unit`, molto prima che qualcuno aspetti un browser.
 */

/** I verbi che scrivono un commit, cioè quelli che hanno bisogno di un autore. */
const NEEDS_AUTHOR = ["commit", "cherry-pick", "revert", "merge", "rebase", "am", "stash"];

interface Offence {
  file: string;
  line: number;
  text: string;
}

function sourceFiles(): string[] {
  return readdirSync(SERVER, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".ts") && !d.name.endsWith(".test.ts"))
    .map((d) => join(d.parentPath ?? SERVER, d.name));
}

/**
 * La chiamata porta con sé un ambiente?
 *
 * Si guarda la finestra intorno allo spawn, non la riga secca: `env` sta quasi
 * sempre nelle opzioni dopo gli argomenti, e la riga può essere spezzata dal
 * formatter. Vale sia `env` esplicito sia il runner iniettabile, che riceve
 * l'ambiente da chi lo chiama (`own-commits.ts:defaultRunGit`).
 */
function envInScope(window: string): boolean {
  return /\benv\b/.test(window);
}

function offences(): Offence[] {
  const found: Offence[] = [];
  for (const file of sourceFiles()) {
    const src = readFileSync(file, "utf8");
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      // Solo gli spawn letterali di git: le chiamate che passano da un runner
      // iniettato sono responsabilità di chi quel runner lo costruisce.
      if (!/spawn\(\s*\[\s*"git"/.test(line)) return;
      const window = lines.slice(i, i + 8).join("\n");
      const writesCommit = NEEDS_AUTHOR.some((verb) =>
        new RegExp(`"${verb}"`).test(window),
      );
      if (!writesCommit) return;
      if (envInScope(window)) return;
      found.push({ file: file.replace(`${SERVER}/`, ""), line: i + 1, text: line.trim() });
    });
  }
  return found;
}

describe("identità git nel codice del server", () => {
  test("ogni git che scrive un commit riceve un ambiente (gitEnvFor)", () => {
    const colpevoli = offences().map((o) => `${o.file}:${o.line} — ${o.text}`);
    expect(
      colpevoli,
      "un `git commit` senza `env: await gitEnvFor(cwd)` muore con exit 128 dove manca ~/.gitconfig (runner CI, container, servizio con ambiente ripulito)",
    ).toEqual([]);
  });

  test("il banco vede davvero le chiamate che deve sorvegliare", () => {
    // Senza questo, un refactor che cambia la forma dello spawn renderebbe il
    // test qui sopra verde per il motivo sbagliato: zero offese perché zero
    // chiamate esaminate. Le due call-site storiche sono `routes/files.ts` e
    // `services/task-automerge.ts`.
    const esaminate = sourceFiles().filter((f) => {
      const src = readFileSync(f, "utf8");
      return /spawn\(\s*\[\s*"git"/.test(src) && NEEDS_AUTHOR.some((v) => new RegExp(`"${v}"`).test(src));
    });
    expect(esaminate.length, "nessuno spawn di git riconosciuto: il matcher non vede più il codice").toBeGreaterThan(0);
  });
});
