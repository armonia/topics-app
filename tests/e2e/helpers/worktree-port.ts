/**
 * Un worktree di dispatch non deve poter prendere la porta 13334.
 *
 * IL DIFETTO. `E2E_PORT` è UNA sola variabile, e da lei discende tutto: la
 * porta del server, la `DATA_DIR`, la fotografia del bundle, i socket del
 * PTY-bridge e dell'ai-bridge, il file di lock della run. Il default era un
 * literal — `13334` — uguale per il checkout principale e per i ~24 worktree
 * che il dispatcher carva sotto `~/.topics/worktrees/topics-app/`. Ogni agente
 * che lancia `npx playwright test` nel suo worktree punta quindi allo stesso
 * numero, allo stesso `/tmp/topics-test-data` e allo stesso socket.
 *
 * COSA SUCCEDEVA. Il `global-setup` fa piazza pulita sulla porta prima di
 * avviare il proprio server (`lsof -ti :PORTA | kill`): con la porta condivisa,
 * «fare piazza pulita» vuol dire ammazzare il server di una run VIVA. Visto due
 * volte di fila: un `[Shutdown] Received SIGTERM` a metà suite e da lì otto
 * ECONNREFUSED che accusavano l'ultimo commit. `run-lock.ts` (2026-07-28)
 * protegge chi ARRIVA secondo, ma non può proteggere chi è già dentro da un
 * checkout che quel codice non ce l'ha: 11 dei 24 worktree vivi sono nati prima.
 * Diagnosi in `server-death.ts`.
 *
 * IL RIMEDIO STRUTTURALE. Non far mai coincidere le porte, invece di
 * arbitrare la collisione dopo. Chi gira da un worktree di dispatch riceve una
 * porta DERIVATA dal path del checkout: stabile (stesso worktree → stessa
 * porta, run dopo run, così `DATA_DIR` e bundle si riusano) e distinta da
 * 13334, che resta intoccabile e riservata al checkout principale. È lo stesso
 * principio di `worktreeIsolationHome` in `server/services/daemon-state.ts`: un
 * worktree non dirotta i default di produzione.
 *
 * `E2E_PORT` esplicita vince sempre — gli shard (`scripts/e2e-shards.sh`) e il
 * «dammi una porta tutta mia» a mano continuano a funzionare identici.
 *
 * Puro (baseDir e home iniettati) perché sia verificabile in `tests/unit`.
 */

import { join, sep } from "path";

/** La porta storica: script, `.gitignore` e memoria muscolare puntano qui. */
export const E2E_DEFAULT_PORT = 13334;

/**
 * La finestra dei worktree. Sopra 13334 e sopra le porte usate a mano dagli
 * shard, sotto i 49152 delle effimere di sistema: 400 slot sono molti più dei
 * worktree che esistono contemporaneamente (24 al massimo osservato).
 */
export const WORKTREE_PORT_BASE = 13500;
export const WORKTREE_PORT_SPAN = 400;

/** FNV-1a 32 bit: deterministico, indipendente dalla piattaforma, due righe. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // moltiplicazione FNV in aritmetica a 32 bit senza segno
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * `true` se `baseDir` è un checkout creato PER UN AGENTE, non il repo
 * dell'utente: sotto `~/.topics/worktrees/` (il dispatcher della board) oppure
 * sotto un `.claude/worktrees/` (i subagent e i workflow di Claude Code, che
 * scavano il loro worktree dentro il repo stesso).
 *
 * La seconda radice manca dal 2026-09-06: dieci agenti di un workflow, ognuno
 * nel suo `.claude/worktrees/wf_…-N`, ricevevano tutti 13334 e il global-setup
 * di ognuno faceva piazza pulita sul server degli altri — lo stesso incidente
 * dell'intestazione, con un'altra cartella.
 */
export function isDispatchWorktree(baseDir: string, home: string): boolean {
  const norm = baseDir.endsWith(sep) ? baseDir : baseDir + sep;
  const dispatcherRoot = join(home, ".topics", "worktrees") + sep;
  const claudeWorktrees = `${sep}.claude${sep}worktrees${sep}`;
  return norm.startsWith(dispatcherRoot) || norm.includes(claudeWorktrees);
}

/**
 * La porta di default per QUESTO checkout. 13334 per il repo principale,
 * una porta stabile in [13500, 13900) per un worktree di dispatch.
 *
 * Due worktree possono in teoria finire sulla stessa porta (400 slot): in quel
 * caso la collisione non è più silenziosa, perché entrambi i checkout sono
 * abbastanza recenti da avere `run-lock.ts` e la seconda run si ferma con un
 * messaggio invece di ammazzare la prima.
 */
export function defaultE2EPort(baseDir: string, home: string): number {
  if (!isDispatchWorktree(baseDir, home)) return E2E_DEFAULT_PORT;
  // Il path normalizzato senza `/` finale: `…/foo` e `…/foo/` sono lo stesso
  // checkout e devono dare la stessa porta.
  const key = baseDir.endsWith(sep) ? baseDir.slice(0, -sep.length) : baseDir;
  return WORKTREE_PORT_BASE + (hash32(key) % WORKTREE_PORT_SPAN);
}
