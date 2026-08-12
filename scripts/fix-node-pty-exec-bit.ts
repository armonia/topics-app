/**
 * Rimette il bit di esecuzione su `spawn-helper` di node-pty. Girato come
 * `postinstall`, quindi dopo OGNI `bun install`.
 *
 * PERCHÉ ESISTE
 * node-pty@1.1.0 pubblica i suoi prebuild dentro il tarball npm, e nel tarball
 * `prebuilds/darwin-arm64/spawn-helper` ha modo `-rw-r--r--`: senza bit di
 * esecuzione. Verificabile senza fidarsi di questo commento:
 *
 *     npm pack node-pty@1.1.0 && tar tvzf node-pty-1.1.0.tgz | grep spawn-helper
 *
 * `spawn-helper` è il programmino che node-pty *esegue* per ogni fork: senza il
 * bit, ogni `pty.spawn()` muore con `posix_spawnp failed.` — non un errore di
 * caricamento del modulo nativo, ma un fallimento allo spawn, che è il motivo
 * per cui somiglia a un guasto di sistema e non a un file col modo sbagliato.
 *
 * COSA ROMPEVA
 * Il ponte PTY del server (`server/pty-bridge.mjs`) fa un self-test proprio con
 * `pty.spawn('/bin/true')` prima di mettersi in ascolto, e su quel fallimento
 * esce. Quindi il server lo rispawnava, quello moriva, e ogni richiesta di
 * terminale rispondeva «Failed to connect to PTY bridge after spawning». Nel
 * banco E2E questo si vedeva come «il terminale non compare»: le spec del
 * terminale erano rosse per costruzione su qualunque checkout con node_modules
 * fresche. La app di produzione non se n'era accorta perché il guscio Tauri usa
 * il ponte **Rust** (`desktop-tauri/pty-bridge`), che non tocca node-pty.
 *
 * PERCHÉ QUI E NON ALTROVE
 * Non è aggirabile con `trustedDependencies`: gli script di install di node-pty
 * (`scripts/prebuild.js`, `scripts/post-install.js`) non fanno chmod — il primo
 * si limita a controllare che la cartella del prebuild esista. Il modo sbagliato
 * arriva dal pacchetto pubblicato, quindi la riparazione tocca a chi lo installa.
 *
 * È idempotente e non fallisce mai l'install: se node-pty non c'è (o il chmod
 * non passa) stampa e esce 0. Un install rotto per colpa di questo script
 * sarebbe peggio del difetto che ripara. Il CANCELLO che rende visibile il
 * problema è invece un test — tests/unit/pty-bridge-e2e-isolation.test.ts.
 */
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Ogni posto in cui node-pty può tenere il suo `spawn-helper`: i prebuild
 *  scaricati e la build locale di node-gyp (Linux, dove prebuild non ce n'è). */
function spawnHelpers(root: string): string[] {
  const found: string[] = [];
  const prebuilds = join(root, "prebuilds");
  if (existsSync(prebuilds)) {
    for (const dir of readdirSync(prebuilds)) {
      const p = join(prebuilds, dir, "spawn-helper");
      if (existsSync(p)) found.push(p);
    }
  }
  const built = join(root, "build", "Release", "spawn-helper");
  if (existsSync(built)) found.push(built);
  return found;
}

export function fixNodePtyExecBit(nodePtyRoot: string): string[] {
  const fixed: string[] = [];
  for (const helper of spawnHelpers(nodePtyRoot)) {
    const mode = statSync(helper).mode & 0o777;
    // Basta il bit del PROPRIETARIO: è l'utente che lancerà lo spawn.
    if (mode & 0o100) continue;
    // `| 0o111` aggiunge l'esecuzione; `& ~0o022` toglie la scrittura a gruppo e
    // altri. Non è zelo: bun estrae questo file 666, e un eseguibile scrivibile
    // da chiunque che un demone lancia a ogni terminale è un buco. 644 e 666
    // finiscono entrambi a 755.
    chmodSync(helper, (mode | 0o111) & ~0o022);
    fixed.push(helper);
  }
  return fixed;
}

if (import.meta.main) {
  const root = join(process.cwd(), "node_modules", "node-pty");
  if (!existsSync(root)) {
    // Install parziale o `--ignore-scripts` altrove: niente da riparare.
    process.exit(0);
  }
  try {
    const fixed = fixNodePtyExecBit(root);
    if (fixed.length) {
      console.log(`[postinstall] node-pty: rimesso il bit +x su ${fixed.length} spawn-helper`);
    }
  } catch (e) {
    console.warn(
      `[postinstall] node-pty: chmod di spawn-helper non riuscito (${e instanceof Error ? e.message : e}). ` +
        `I terminali non partiranno finché non è eseguibile.`,
    );
  }
}
