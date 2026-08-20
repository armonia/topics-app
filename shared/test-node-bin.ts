/**
 * DOVE STA `node`, per i test che devono lanciarlo.
 *
 * PERCHE' ESISTE, ed e' una lezione pagata. Due file di test lanciano il ponte
 * PTY — che e' un `.mjs` e gira su Node, non su Bun, perche' usa `node-pty` —
 * scrivendo la stringa `"node"` in `Bun.spawn`. Quella stringa si risolve nel
 * PATH, e il PATH di chi esegue i test NON e' garantito: su questa macchina Node
 * sta in `/opt/homebrew/bin`, che un ambiente non interattivo (un agente, un
 * hook, una shell senza profilo) tipicamente non ha.
 *
 * Il danno non era il fallimento, era COME falliva. `Bun.spawn` moriva con
 * `ENOENT` dentro l'helper di avvio, e otto test uscivano rossi accusando lo
 * shutdown del ponte e il monitor anti-orfano. Sono stati archiviati come
 * «preesistenti» sulla base di un confronto con `git stash` — rossi con le
 * modifiche, rossi senza — che era corretto e portava alla conclusione
 * sbagliata: erano rossi in entrambi i casi perche' la causa non stava in
 * nessun commit.
 *
 * Vive qui, in `shared/`, e non accanto a uno dei due file, perche' i suoi due
 * chiamanti stanno in alberi diversi (`server/` e `tests/integration/`) e
 * `server/` non importa dai test. Copiarlo avrebbe voluto dire due ricerche che
 * divergono, e la seconda si scopre rotta solo quando fallisce come la prima.
 */

import fs from "node:fs";

/**
 * L'eseguibile `node` da usare nei test.
 *
 * Ordine: la variabile esplicita, poi i tre percorsi soliti su macOS/Linux,
 * poi il PATH — che e' la via normale quando c'e'. L'ultimo ripiego resta
 * `"node"` nudo, cosi' su una piattaforma con Node in un posto inatteso il
 * comportamento e' quello di prima invece di un errore certo.
 */
export function resolveNodeBin(): string {
  const candidati = [
    process.env.TOPICS_TEST_NODE,
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ].filter((p): p is string => !!p);
  for (const c of candidati) {
    try { if (fs.existsSync(c)) return c; } catch { /* percorso illeggibile */ }
  }
  return "node";
}

/**
 * Il messaggio da sollevare quando `node` non si trova PROPRIO.
 *
 * ACCUSA L'AMBIENTE, non il codice sotto test: un `ENOENT` grezzo produceva
 * rossi che sembravano difetti del ponte, ed e' costata una diagnosi vera. Un
 * rosso deve dire cosa manca e come si ripara.
 */
export function nodeMancanteMessage(bin: string, causa: unknown): string {
  const dettaglio = causa instanceof Error ? causa.message : String(causa);
  return (
    `Non si riesce a lanciare il ponte con \`${bin}\`: ${dettaglio}\n` +
    `Questo test ha bisogno di Node (il ponte e' un .mjs che usa node-pty), e non e' un difetto del codice.\n` +
    `Aggiungi Node al PATH (es. /opt/homebrew/bin) oppure indica l'eseguibile con TOPICS_TEST_NODE=/percorso/di/node.`
  );
}
