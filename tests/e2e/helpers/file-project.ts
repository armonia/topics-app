/**
 * Il progetto-fixture della famiglia file-explorer, in UN posto solo.
 *
 * PERCHÉ ESISTE. `file-explorer.spec.ts` era un file solo da 22 test e 138
 * secondi: il singolo pezzo più lento della suite, e — poiché Playwright
 * distribuisce gli shard PER FILE — anche il suo pavimento. Con 4 shard o con
 * 16, il wall-clock non poteva scendere sotto quei 138s, perché quel file non
 * si spezza. Spezzarlo in tre temi (albero/editor, git, processi) toglie il
 * pavimento; ma tre file hanno bisogno dello stesso progetto seminato, e
 * ricopiarne il setup tre volte significa che la prossima modifica alla
 * fixture ne aggiorna due su tre.
 *
 * COSA SEMINA. Un repo git vero in /tmp con tre stati git già presenti, che
 * sono ciò su cui i test asseriscono:
 *   - `src/index.ts`  modificato dopo il commit  → stato **M**
 *   - `README.md`     cancellato dopo il commit  → stato **D**
 *   - `newfile.txt`   mai committato             → stato **U**
 * Più un `package.json` con degli script, che è ciò che lo ScriptRunner elenca.
 *
 * PERCHÉ UN `label` OBBLIGATORIO. Ogni file di spec deve avere il SUO progetto:
 * i test che committano (FILE-16/17) cambiano lo stato git, e un file che gira
 * in parallelo su un altro shard non deve vederselo cambiare sotto. Il label
 * entra sia nel path temporaneo sia nel nome della topic, così i due non si
 * incrociano mai — nemmeno dentro lo stesso shard, dove i file girano in
 * sequenza sullo stesso server.
 */

import type { APIRequestContext } from "@playwright/test";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, rmSync, unlinkSync, realpathSync } from "fs";
import { createTopic, deleteTopic } from "./api-fixtures";

export type FileProject = {
  topicId: string;
  tmpDir: string;
  topicName: string;
};

/**
 * A scratch folder under /tmp, named the way the project window will REALLY
 * name it on screen.
 *
 * Since 7cd202448 the server serves the `project:<path>` pane under its
 * CANONICAL path (realpath), and on macOS `/tmp` is a link to `/private/tmp`:
 * a spec that seeds `/tmp/e2e-x` and then looks for
 * `[data-project-path="/tmp/e2e-x"]` waits ten seconds for a window that is
 * there the whole time, under the other name. On the Linux runner `/tmp` is a
 * real directory and the two spellings coincide, so the red showed only on the
 * laptop — the most expensive kind of red, because whoever reproduces locally
 * finds a failure that does not exist in CI.
 *
 * The ROOT is resolved, not the folder: the folder does not exist yet, and
 * `realpathSync` on a missing path throws.
 */
export function canonicalTmpDir(prefix: string): string {
  return `${canonicalTmpRoot()}/${prefix}-${Date.now()}`;
}

/**
 * The scratch ROOT, canonical: `/private/tmp` on macOS, `/tmp` on Linux.
 *
 * Same defect as above, seen from the other side. A board id is a hash of the
 * project path (`projectIdForPath`), and the server hashes the CANONICAL one:
 * a spec that seeds its cards on `boardIdForPath("/tmp/e2e-x")` and then opens
 * the window of that folder is looking at a DIFFERENT board, empty, while its
 * tasks sit on the id nobody asks for. It cost three cards (7cd202448,
 * 7fdf85b2e and this one) because on the Linux runner the two spellings are
 * the same string and the suite stays green.
 *
 * The whole point is to be a FUNCTION and not a constant: at module level a
 * spec composes its path before anything is on disk, and only the root can be
 * resolved that early. `scripts/check-tmp-canonical.ts` is what keeps the
 * literal from coming back.
 */
export function canonicalTmpRoot(): string {
  try {
    return realpathSync("/tmp");
  } catch {
    return "/tmp";
  }
}

/**
 * `git init` + primo commit in una cartella di prova.
 *
 * L'IDENTITÀ È OBBLIGATORIA, e non è pignoleria: senza, `git commit` fallisce
 * con «Please tell me who you are» ovunque non ci sia una config globale — cioè
 * su CI. È così che il nightly è rimasto rosso tre notti di fila
 * (`Command failed: git commit -m init`), mentre in locale non si vedeva niente
 * perché la config dell'utente copriva il buco.
 *
 * `commit.gpgsign=false` copre l'altro verso: se l'utente firma i commit, la
 * richiesta di passphrase parte in un processo che nessuno guarda e il test
 * resta appeso fino al timeout, senza dire perché.
 *
 * Sta qui perché era ricopiato in tre fixture e una sola aveva l'identità: è la
 * ragione per cui il rosso si vedeva solo su CI e solo in un file.
 *
 * `execFileSync` con un array, non `execSync` con una stringa: niente shell di
 * mezzo, quindi il percorso non può essere reinterpretato come comando.
 */
export function initGitRepo(dir: string, message = "init"): void {
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=e2e", "-c", "user.email=e2e@test", "-c", "commit.gpgsign=false", ...args],
      { cwd: dir, stdio: "pipe" },
    );
  // `-b main` e non `git init` liscio: il nome del ramo iniziale lo decide
  // `init.defaultBranch`, cioe' la CONFIG DELLA MACCHINA. Su un portatile che
  // ce l'ha impostato nasce `main` e le spec che leggono l'etichetta del ramo
  // passano; sul runner, che non ha nessuna config globale, nasce `master` e la
  // stessa asserzione cade — con un errore che parla di un locator, non di git.
  // Misurato l'08/08 su `git-untracked-folder`: lo screenshot del runner mostra
  // il pannello CORRETTO, «Non tracciata dal repo «e2e-host-repo-…»», ma senza
  // « · main» accanto, e l'unica asserzione a cadere era quella sull'etichetta.
  // Stessa famiglia dell'identita' passata con `-c` qui sopra: il test non deve
  // dipendere da come e' configurata la macchina che lo esegue.
  // `worktree-domain.spec.ts` e `board-diff-review.spec.ts` lo facevano gia'.
  git("init", "-b", "main");
  git("add", "-A");
  git("commit", "-m", message);
}

/**
 * Crea il repo di prova e la topic che lo punta.
 *
 * @param label discriminante per file di spec (es. "tree", "git", "proc") — vedi sopra.
 */
export async function seedFileProject(
  request: APIRequestContext,
  label: string,
): Promise<FileProject> {
  const tmpDir = canonicalTmpDir(`e2e-files-${label}`);
  const topicName = `e2e-file-explorer-${label}`;

  mkdirSync(`${tmpDir}/src`, { recursive: true });

  writeFileSync(
    `${tmpDir}/package.json`,
    JSON.stringify(
      {
        name: "e2e-test-project",
        scripts: { dev: "echo dev", build: "echo build", test: "echo test" },
      },
      null,
      2,
    ),
  );
  writeFileSync(`${tmpDir}/README.md`, "# E2E Test Project\n");
  writeFileSync(`${tmpDir}/src/index.ts`, 'export const hello = "world";\n');

  initGitRepo(tmpDir, "initial");

  // Gli stati git su cui i test asseriscono (vedi l'intestazione del modulo).
  writeFileSync(`${tmpDir}/src/index.ts`, 'export const hello = "modified";\n'); // M
  unlinkSync(`${tmpDir}/README.md`); // D
  writeFileSync(`${tmpDir}/newfile.txt`, "new content\n"); // U

  const topic = await createTopic(request, topicName, { projectPath: tmpDir });
  return { topicId: topic.id, tmpDir, topicName };
}

/** Smonta ciò che `seedFileProject` ha creato. Idempotente: si può chiamare a vuoto. */
export async function cleanupFileProject(
  request: APIRequestContext,
  project: FileProject | undefined,
): Promise<void> {
  if (!project) return;
  if (project.topicId) await deleteTopic(request, project.topicId).catch(() => {});
  rmSync(project.tmpDir, { recursive: true, force: true });
}
