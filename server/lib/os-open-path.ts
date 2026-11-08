/**
 * La sonda: il path che l'OS ha consegnato, guardato sul disco.
 *
 * La REGOLA (cartella = progetto, file = progetto che lo contiene + fuoco sul
 * file) sta in `shared/os-open-path.ts` ed è pura. Qui c'è l'unica cosa che
 * quella funzione non può sapere da sola: com'è fatto davvero il filesystem.
 * Tre domande, tre risposte, poi si decide altrove.
 *
 * PERCHÉ LA SONDA STA SUL SERVER e non nel guscio Rust. Il client gira anche
 * fuori da Tauri (browser, telefono) e il server è l'unico che vede il disco in
 * tutti e due i casi; il guscio, invece, dovrebbe reimparare in Rust la
 * risalita ai marcatori e la lista dei progetti aperti, cioè tenere una seconda
 * copia della stessa regola. Il guscio consegna un path e basta.
 *
 * Le dipendenze sono iniettate perché la risalita si prova senza costruire un
 * albero di cartelle finte a ogni caso: il disco è un parametro.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TabTarget } from "../../shared/tab-link";
import {
  ancestorDirs,
  normalizeOsOpenPath,
  osOpenTarget,
  MANIFEST_MARKERS,
  VCS_MARKERS,
} from "../../shared/os-open-path";

export interface OsOpenProbe {
  /** Il path esiste, ed è una cartella? `null` = non esiste. */
  kindOf(path: string): "dir" | "file" | null;
  /** C'è `marker` dentro `dir`? */
  hasMarker(dir: string, marker: string): boolean;
  /** I progetti che l'app conosce già (path assoluti). */
  knownProjects(): string[];
}

/** La sonda vera: filesystem + registro dei progetti. */
export function fsProbe(knownProjects: () => string[]): OsOpenProbe {
  return {
    kindOf(path) {
      try {
        return statSync(path).isDirectory() ? "dir" : "file";
      } catch {
        return null;
      }
    },
    hasMarker(dir, marker) {
      try {
        return existsSync(join(dir, marker));
      } catch {
        return false;
      }
    },
    knownProjects,
  };
}

/**
 * Quanti antenati si risalgono al massimo cercando un marcatore.
 *
 * Un tetto e non «fino alla radice»: un file dentro venti cartelle annidate
 * costerebbe venti giri di `existsSync` per marcatore, e oltre una decina di
 * livelli sopra il file la risposta non è più «il progetto di questo file», è
 * un indovinello. Chi non trova niente entro il tetto ricade sulla cartella
 * contenitrice, che è sempre una risposta onesta.
 */
const MAX_ANCESTORS = 12;

/**
 * Path dall'OS → la tab da aprire, o `null` se non c'è niente da aprire (path
 * malformato, o che sul disco non esiste).
 *
 * Un path inesistente NON diventa una cartella nuova: aprire un progetto su
 * qualcosa che non c'è lascerebbe in sidebar una riga che non si può nemmeno
 * riaprire.
 */
export function resolveOsOpenPath(raw: string, probe: OsOpenProbe): TabTarget | null {
  const path = normalizeOsOpenPath(raw);
  if (!path) return null;

  const kind = probe.kindOf(path);
  if (kind === null) return null;
  if (kind === "dir") return osOpenTarget(path, { isDirectory: true });

  const ancestors = ancestorDirs(path).slice(0, MAX_ANCESTORS);
  const vcsRoots: string[] = [];
  const manifestRoots: string[] = [];
  for (const dir of ancestors) {
    if (VCS_MARKERS.some((m) => probe.hasMarker(dir, m))) vcsRoots.push(dir);
    if (MANIFEST_MARKERS.some((m) => probe.hasMarker(dir, m))) manifestRoots.push(dir);
  }

  return osOpenTarget(path, {
    isDirectory: false,
    knownProjects: probe.knownProjects(),
    vcsRoots,
    manifestRoots,
  });
}
