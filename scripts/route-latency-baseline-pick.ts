import { resolve } from "node:path";

/**
 * QUALE BASELINE, perche' una sola non poteva bastare.
 *
 * Il commento di `calibrationOutOfScale` lo diceva gia' e questa e' la riga che
 * lo mantiene: «per quella serve una baseline registrata SUL runner e scelta
 * per macchina». Finche' il file era uno solo, il cancello rispondeva sempre
 * alla stessa domanda sbagliata — «questa macchina e' veloce quanto un M2 Max
 * scarico?» — e su qualunque altra usciva 2 (non misurabile) o un rosso che
 * descriveva l'hardware.
 *
 * Misurato il 2026-08-20 sulla postazione dell'utente, sei giri a load 24-27:
 * `topic_messages` 27,29 contro 15,18 ms fra due passate consecutive, e il
 * costo di prima chiamata di `dispatch_capacity` che `declared_limits`
 * documenta (2,0-2,5 poi 0,4-0,6, «SEMPRE in quest'ordine») non si riproduce
 * piu'. Non era una regressione: era Dia all'86% di un core.
 *
 * La chiave e' l'AMBIENTE, non il modello di CPU: `ci` quando gira in CI
 * (`GITHUB_ACTIONS`), altrimenti `local`. E' la distinzione che conta davvero,
 * perche' separa «VM condivisa, carico ignoto» da «postazione di qualcuno».
 * Un file per macchina fisica sarebbe piu' preciso e inutile: nessuno lo
 * aggiornerebbe.
 *
 * RIPIEGO ESPLICITO: se il file dell'ambiente non c'e', si usa quello storico
 * — cosi' chi non ha ancora registrato il suo continua ad avere il cancello di
 * prima invece di un errore. Il nome del file usato finisce nel referto, che e'
 * l'unico modo perche' un confronto fra macchine diverse si veda.
 */
export function baselineEnvKey(env: NodeJS.ProcessEnv = process.env): "ci" | "local" {
  return env.GITHUB_ACTIONS === "true" || env.CI === "true" ? "ci" : "local";
}

/** Il file per un ambiente, e quello storico come ripiego. */
export function baselineCandidates(envKey: "ci" | "local", root: string): string[] {
  return [
    resolve(root, `scripts/route-latency-baseline.${envKey}.json`),
    resolve(root, "scripts/route-latency-baseline.json"),
  ];
}

/** Il primo che esiste. `null` quando non c'e' nessuna baseline da nessuna parte. */
export function pickBaselinePath(
  envKey: "ci" | "local",
  exists: (p: string) => boolean,
  root: string,
): string | null {
  for (const p of baselineCandidates(envKey, root)) if (exists(p)) return p;
  return null;
}

/** I due percorsi di questa corsa, risolti insieme perche' rispondono alla
 *  stessa domanda: dove si LEGGE e dove si SCRIVE.
 *
 *  Sono due e non uno perche' `--update-baseline` deve scrivere SOLO sul file
 *  dell'ambiente — registrare su una macchina non puo' sovrascrivere il numero
 *  dell'altra, che era il difetto originale — mentre la lettura ripiega sullo
 *  storico per non rompere il cancello di chi non ha ancora registrato il suo.
 *
 *  CHI CHIAMA DEVE DIRE QUALE HA USATO. Un rosso preso su una macchina e un
 *  verde preso su un'altra, senza quel nome accanto, si leggono come lo stesso
 *  esito — ed e' il confronto fra numeri di provenienza diversa che ha reso
 *  questo cancello muto per giorni. */
export function resolveBaselinePaths(
  root: string,
  exists: (p: string) => boolean,
  env: NodeJS.ProcessEnv = process.env,
): { envKey: "ci" | "local"; read: string; write: string } {
  const envKey = baselineEnvKey(env);
  const write = baselineCandidates(envKey, root)[0]!;
  return { envKey, write, read: pickBaselinePath(envKey, exists, root) ?? write };
}
