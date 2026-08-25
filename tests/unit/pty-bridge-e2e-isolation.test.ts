/**
 * Il ponte PTY del banco E2E: deve poter PARTIRE, e non deve mai toccare quello
 * di produzione.
 *
 * Storia. Le spec del terminale (`terminal.spec.ts`, `terminal-reconnect.spec.ts`,
 * …) erano rosse su main, tre giri su tre, e sempre nello stesso punto: l'helper
 * di preparazione aspettava `.xterm-rows` e non lo trovava mai. Sembrava un
 * problema di isolamento del banco — `scripts/start-test-server.sh` gli dà un
 * socket dedicato, e l'ipotesi era che nessuno ci avviasse un ponte sopra. Non
 * era così: il server lo avvia eccome (`ensureBridge`, server/routes/terminal.ts).
 * Il ponte partiva, falliva il proprio self-test con
 *
 *     [PTY Bridge] Self-test failed: posix_spawnp failed.. Exiting.
 *
 * e moriva prima di mettersi in ascolto — perché `spawn-helper` di node-pty
 * arriva dal tarball npm senza bit di esecuzione (vedi
 * scripts/fix-node-pty-exec-bit.ts, che è la riparazione).
 *
 * Perché il test sta QUI e non fra le E2E. Il difetto vero non è il modo di un
 * file: è che quel rosso non lo guardava nessun cancello. I quattro cancelli sono
 * typecheck, lint, check:deadcode e `test:unit`; le E2E non ci sono, quindi una
 * spec E2E può restare rossa per settimane senza che nulla lo dica. Questo test
 * gira dentro `test:unit`, cioè dentro un cancello — è il pezzo che mancava.
 *
 * Nota sulla portata: su Linux node-pty non pubblica prebuild, quindi lì
 * `spawn-helper` può legittimamente non esserci. Il test non finge di misurare
 * ciò che non c'è: dice ESPLICITAMENTE quale caso sta guardando, e su macOS —
 * dove il difetto vive e dove girano le E2E del terminale — è pienamente vivo.
  * @covers E2E-GATE-06
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const REPO = path.join(import.meta.dir, "../..");
const NODE_PTY = path.join(REPO, "node_modules", "node-pty");

/** Tutti i `spawn-helper` presenti: i prebuild scaricati + la build node-gyp. */
function spawnHelpers(): string[] {
  const found: string[] = [];
  const prebuilds = path.join(NODE_PTY, "prebuilds");
  if (existsSync(prebuilds)) {
    for (const dir of readdirSync(prebuilds)) {
      const p = path.join(prebuilds, dir, "spawn-helper");
      if (existsSync(p)) found.push(p);
    }
  }
  const built = path.join(NODE_PTY, "build", "Release", "spawn-helper");
  if (existsSync(built)) found.push(built);
  return found;
}

describe("il ponte PTY può partire", () => {
  test("ogni spawn-helper di node-pty è eseguibile", () => {
    if (!existsSync(NODE_PTY)) {
      // Niente node-pty = niente ponte Node = niente da misurare. Non è un
      // caso normale (è una dipendenza dichiarata), quindi lo si dice forte.
      throw new Error(
        `node_modules/node-pty manca: lancia \`bun install\`. Senza, il ponte PTY ` +
          `non esiste e ogni terminale — app e banco E2E — è morto.`,
      );
    }
    const helpers = spawnHelpers();
    const nonEseguibili = helpers.filter((p) => !(statSync(p).mode & 0o100));
    expect(
      nonEseguibili,
      `spawn-helper senza bit +x: node-pty morirà con "posix_spawnp failed" a ogni ` +
        `spawn, e con lui il ponte PTY. Riparazione: \`bun run scripts/fix-node-pty-exec-bit.ts\` ` +
        `(gira da solo come postinstall).\n${nonEseguibili.join("\n")}`,
    ).toEqual([]);
  });

  test("su questa piattaforma un binario nativo di node-pty c'è davvero", () => {
    // La metà che rende l'assert qui sopra non-vacuo dove conta. Su darwin il
    // prebuild della coppia piattaforma+arch DEVE esserci: se sparisse, il test
    // sopra passerebbe su una lista vuota senza dire niente.
    if (process.platform !== "darwin") return; // Linux/Windows: vedi nota in testa
    const dir = path.join(NODE_PTY, "prebuilds", `${process.platform}-${process.arch}`);
    expect(existsSync(path.join(dir, "spawn-helper")), `manca ${dir}/spawn-helper`).toBe(true);
  });
});

describe("il banco non tocca il ponte di produzione", () => {
  const startScript = readFileSync(path.join(REPO, "scripts/start-test-server.sh"), "utf-8");
  const teardown = readFileSync(path.join(REPO, "tests/e2e/global-teardown.ts"), "utf-8");

  test("start-test-server.sh esporta un socket dedicato al banco", () => {
    // La garanzia del 2026-07-02: un server di test non deve poter attaccarsi al
    // ponte di produzione, la cui riconciliazione ucciderebbe i PTY vivi.
    expect(startScript).toMatch(/export TOPICS_PTY_SOCKET=.*topics-pty-bridge-e2e-/);
  });

  test("il teardown ammazza SOLO il ponte del banco", () => {
    // Il ponte è `detached` + `unref()`: sopravvive alla morte del server, e
    // senza questo passo ogni run lascerebbe un orfano. Il come conta: deve
    // partire dal socket del banco (o dal suo pidfile), MAI da un `pkill` sul
    // nome — che porterebbe via anche il ponte di produzione con dentro le
    // sessioni Claude vive dell'utente.
    const codeLines = teardown
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
    const joined = codeLines.join("\n");

    expect(joined, "il teardown non spegne il ponte PTY del banco").toMatch(
      /topics-pty-bridge-e2e-|ptySocketPath|PTY_SOCKET/,
    );
    const perNome = codeLines.filter((l) => /pkill|killall/.test(l) && /pty-bridge/.test(l));
    expect(
      perNome,
      `kill per NOME del processo: prenderebbe anche il ponte di produzione.\n${perNome.join("\n")}`,
    ).toEqual([]);
  });
});
