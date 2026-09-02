/**
 * L'identità di un progetto è la cartella, non la stringa con cui ci sei arrivato.
 *
 * `projectIdForPath` (shared/board.ts) è `basename + hash della STRINGA`, e le
 * chiavi `ui_state` usano un hash gemello. Quindi due percorsi che puntano alla
 * stessa cartella — uno diretto, uno attraverso un symlink — producono due
 * progetti distinti: due voci in sidebar, due board, due pannelli. Misurato il
 * 02/09/2026: `~/.openclaw/workspace/neuture-proposal` è un link a
 * `~/Projects/neuture-proposal`, e neuture compariva due volte.
 *
 * Qui si risolve il link UNA VOLTA, quando il percorso ENTRA. Non si tocca
 * niente di già scritto: cambiare il percorso di un progetto esistente ne cambia
 * l'id e orfanerebbe le sue righe `tasks` — è la «board vuota» già pagata una
 * volta. Questa funzione impedisce che nasca la SECONDA identità; quelle già
 * nate si fondono con una migrazione a parte, che le riscrive in transazione.
 *
 * Un percorso che non esiste ancora si tiene com'è: non c'è niente da risolvere,
 * e rifiutarlo trasformerebbe «cartella non ancora creata» in un errore.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function canonicalProjectPath(p: string | null | undefined): string {
  // Si espande PRIMA e si normalizza DOPO: `~/` con la barra finale non inizia
  // piu' per `~/` una volta tagliata, e restava la stringa letterale "~".
  const raw = String(p ?? "").trim();
  if (!raw) return "";
  const espanso = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  const abs = espanso.replace(/(.)\/+$/, "$1");
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}
