/**
 * Il CANCELLO del runtime: quale meccanica esegue gli agenti, e cosa entra nel
 * registro di conseguenza.
 *
 * Perché merita un file suo. `jcode` sta nella tabella dei noti insieme a
 * `gemini`, ma le due righe non hanno lo stesso significato: gemini è «un
 * agente che sappiamo lanciare», jcode è «l'altra META' di un interruttore».
 * Registrarlo quando nessuno l'ha chiesto non è una voce in piu' nel picker —
 * lo rende eleggibile come DEFAULT automatico appena una CLI risulta
 * disconnessa, cioe' cambia da solo su cosa girano gli agenti di qualcuno.
 *
 * I test non fanno partire nessun provider: leggono la lista che
 * `initProviders` userebbe. È la decisione, senza il costo di spawnare CLI vere
 * per osservarla.
 */
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveAcpAgents } from "./index";
import { initDatabase, closeDatabase } from "../db";
import { updateAppSettings } from "../services/app-settings";

const ENV = ["ACP_AGENTS", "TOPICS_AGENT_RUNTIME"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV) saved[k] = process.env[k];

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
});

afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const names = (): string[] => resolveAcpAgents().map((a) => a.name);

describe("il cancello del runtime sugli agenti ACP", () => {
  // Il default. Senza questo, chi aggiorna si troverebbe un provider nuovo
  // registrato senza averlo chiesto.
  test("runtime `cli` (il default): jcode NON entra, gli altri agenti sì", () => {
    expect(names()).not.toContain("jcode");
    expect(names()).toContain("gemini");
  });

  test("runtime `jcode`: entra, ed è l'unica differenza", () => {
    process.env.TOPICS_AGENT_RUNTIME = "jcode";
    expect(names()).toContain("jcode");
    expect(names()).toContain("gemini");
  });

  // Il caso che il filtro non deve rompere: `ACP_AGENTS` è il modo ESPLICITO di
  // chiedere un agente per nome. Un interruttore di meccanica non ha titolo per
  // annullare una richiesta nominale — chi scrive quella variabile sta dicendo
  // «questo lo voglio», e vale anche se punta a un binario suo.
  test("dichiarato a mano in ACP_AGENTS, passa anche col runtime `cli`", () => {
    process.env.ACP_AGENTS = JSON.stringify([
      { name: "jcode", command: "/opt/jcode/bin/jcode", args: ["acp"] },
    ]);
    const agents = resolveAcpAgents();
    expect(agents.map((a) => a.name)).toContain("jcode");
    // E vince sulla riga nota, come per ogni altro agente dichiarato: chi
    // dichiara sta CORREGGENDO la tabella, non aggiungendo un doppione.
    expect(agents.find((a) => a.name === "jcode")!.command).toBe("/opt/jcode/bin/jcode");
  });

  test("un `ACP_AGENTS` che parla d'altro non riapre il cancello", () => {
    process.env.ACP_AGENTS = JSON.stringify([{ name: "goose", command: "goose", args: ["acp"] }]);
    expect(names()).toContain("goose");
    expect(names()).not.toContain("jcode");
  });

  // La riga in Impostazioni, sul database vero: il cancello legge
  // `resolveAgentRuntime`, che legge la colonna. Passa dal DB e non da un
  // doppio del modulo perché il ramo che conta è proprio «la scelta salvata
  // arriva fin qui», e un modulo sostituito proverebbe solo che il test sa
  // sostituire un modulo.
  test("la scelta salvata in Impostazioni comanda quanto l'env", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "runtime-gate-"));
    const migDir = join(tmpRoot, "server", "db", "migrations");
    mkdirSync(migDir, { recursive: true });
    const realMigDir = join(import.meta.dir, "..", "db", "migrations");
    for (const f of readdirSync(realMigDir)) {
      if (!f.endsWith(".sql")) continue;
      writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
    }
    const savedDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = join(tmpRoot, "data");
    try {
      initDatabase(tmpRoot);
      expect(names()).not.toContain("jcode");
      updateAppSettings({ agentRuntime: "jcode" });
      expect(names()).toContain("jcode");
    } finally {
      try { closeDatabase(); } catch { /* già chiuso */ }
      if (savedDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = savedDataDir;
      try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* scratch */ }
    }
  });
});
