import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * I QUATTRO POSTI in cui è scritta la versione dell'app, e come si legge ognuno.
 *
 * Sta in un modulo suo — e non dentro `version-lockstep.test.ts`, dove è nato —
 * perché due test lo leggono con lo stesso metro: il cancello, che misura il
 * checkout vero, e `bump-version.test.ts`, che misura un albero di prova dopo
 * aver eseguito `bun run bump`. Se i due leggessero con due regex diverse, la
 * prova che il gesto funziona proverebbe un'altra cosa rispetto a quella che il
 * cancello controlla, ed è esattamente il tipo di scollamento che sta al centro
 * di questa storia.
 *
 * Le stesse quattro espressioni stanno in `scripts/bump-version.sh` dal lato
 * della SCRITTURA. Restano due copie di proposito: una in bash/python che scrive
 * e una in TS che legge: se un formato cambia e lo script non trova più la riga,
 * lui esce non-zero e questi test leggono `null` — due segnali indipendenti.
 */
export const PKG = "package.json";
export const TAURI = "desktop-tauri/src-tauri/tauri.conf.json";
export const CARGO = "desktop-tauri/src-tauri/Cargo.toml";
export const LOCK = "desktop-tauri/src-tauri/Cargo.lock";

/** I quattro file, nell'ordine in cui li scrive `scripts/bump-version.sh`. */
export const VERSION_FILES = [PKG, TAURI, CARGO, LOCK] as const;

function read(root: string, rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

/**
 * La versione dichiarata da ciascuno dei quattro file sotto `root`, per path.
 * `null` = «il formato del file è cambiato e non so più leggerlo», che è un caso
 * diverso da «le versioni non coincidono» e va tenuto distinto da chi asserisce.
 *
 * - JSON: la prima `"version": "X.Y.Z"` = quella di primo livello.
 * - `Cargo.toml`: `version = "X.Y.Z"` ancorata a inizio riga — le versioni delle
 *   dipendenze sono inline (`name = { version = "…" }`), mai a inizio riga.
 * - `Cargo.lock`: la stanza `[[package]]` il cui nome è `app` — il crate di
 *   questa app, non una delle sue ~600 dipendenze.
 */
export function readVersions(root: string): Record<string, string | null> {
  const json = (rel: string) => /"version"\s*:\s*"(\d+\.\d+\.\d+)"/.exec(read(root, rel))?.[1] ?? null;
  return {
    [PKG]: json(PKG),
    [TAURI]: json(TAURI),
    [CARGO]: /^version\s*=\s*"(\d+\.\d+\.\d+)"/m.exec(read(root, CARGO))?.[1] ?? null,
    [LOCK]: /^name = "app"\nversion = "(\d+\.\d+\.\d+)"/m.exec(read(root, LOCK))?.[1] ?? null,
  };
}
