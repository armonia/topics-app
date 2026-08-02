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
import { mkdirSync, writeFileSync, rmSync, unlinkSync } from "fs";
import { createTopic, deleteTopic } from "./api-fixtures";

export type FileProject = {
  topicId: string;
  tmpDir: string;
  topicName: string;
};

/**
 * Crea il repo di prova e la topic che lo punta.
 *
 * @param label discriminante per file di spec (es. "tree", "git", "proc") — vedi sopra.
 */
export async function seedFileProject(
  request: APIRequestContext,
  label: string,
): Promise<FileProject> {
  const tmpDir = `/tmp/e2e-files-${label}-${Date.now()}`;
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

  // Identità e firma esplicite: sotto CI (e in una HOME isolata) `git commit`
  // fallisce con "Please tell me who you are" se non le trova, e `commit.gpgsign`
  // dell'utente vero farebbe partire una richiesta di passphrase che nessuno
  // vedrà mai — il test resterebbe appeso fino al timeout senza dire perché.
  //
  // `execFileSync` con un array, non `execSync` con una stringa: niente shell di
  // mezzo, quindi `tmpDir` non può essere reinterpretato come comando.
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=e2e", "-c", "user.email=e2e@test", "-c", "commit.gpgsign=false", ...args],
      { cwd: tmpDir, stdio: "pipe" },
    );
  git("init");
  git("add", "-A");
  git("commit", "-m", "initial");

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
