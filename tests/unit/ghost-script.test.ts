/**
 * Unit tests per `isGhostScript` e `hasRunningScriptsInWorktree`.
 *
 * Spec (task e3240a22): una funzione pura che risponde alla domanda
 * «questo processo di Topics sta girando su un terreno che non c'e' piu'?»
 *
 * Tabella delle veriche (dalla spec):
 *   - worktree viva → NO
 *   - worktree cancellata → SI
 *   - cwd in ~/Projects/dancerooms → NO (non e' un worktree di Topics)
 *   - source:"detected" → NO (non e' di proprieta' di Topics)
 *   - symlink /tmp vs /private/tmp su worktree viva → NO (canonicalizzato)
  * @covers PROCESS-11
 */
import { describe, it, expect } from "bun:test";
import { isGhostScript, hasRunningScriptsInWorktree } from "../../server/lib/ghost-script";

const BASE = "/home/user/.topics/worktrees";

function makeOpts(over: Partial<Parameters<typeof isGhostScript>[0]> = {}): Parameters<typeof isGhostScript>[0] {
  return {
    cwdReal: BASE + "/dancerooms/clear-torch",
    worktreeRoots: new Set<string>(),   // di default: nessuna worktree viva
    worktreesBase: BASE,
    source: "script",
    status: "running",
    pid: 12345,
    ...over,
  };
}

describe("isGhostScript", () => {
  it("worktree cancellata → SI (caso base)", () => {
    expect(isGhostScript(makeOpts())).toBe(true);
  });

  it("worktree viva: cwd dentro una root esistente → NO", () => {
    const root = BASE + "/dancerooms/clear-torch";
    expect(isGhostScript(makeOpts({
      cwdReal: root + "/packages/app",
      worktreeRoots: new Set([root]),
    }))).toBe(false);
  });

  it("cwd UGUALE alla root viva → NO", () => {
    const root = BASE + "/dancerooms/clear-torch";
    expect(isGhostScript(makeOpts({
      cwdReal: root,
      worktreeRoots: new Set([root]),
    }))).toBe(false);
  });

  it("cwd in ~/Projects/dancerooms (non un worktree Topics) → NO", () => {
    expect(isGhostScript(makeOpts({
      cwdReal: "/home/user/Projects/dancerooms",
    }))).toBe(false);
  });

  it("source 'detected' → NO (non e' di Topics)", () => {
    expect(isGhostScript(makeOpts({ source: "detected" }))).toBe(false);
  });

  it("source 'shell' → NO", () => {
    expect(isGhostScript(makeOpts({ source: "shell" }))).toBe(false);
  });

  it("status 'done' → NO (non sta girando)", () => {
    expect(isGhostScript(makeOpts({ status: "done" }))).toBe(false);
  });

  it("pid null → NO (non possiamo identificarlo)", () => {
    expect(isGhostScript(makeOpts({ pid: null }))).toBe(false);
  });

  it("symlink canonicalizzato: /tmp vs /private/tmp su worktree viva → NO", () => {
    // Su macOS /tmp -> /private/tmp; se la root e' gia' canonicalizzata e il
    // cwd e' canonicalizzato, devono coincidere.
    const root = "/private/tmp/wt/dancerooms/clear-torch";
    expect(isGhostScript({
      cwdReal: root + "/src",          // canonicalizzato
      worktreeRoots: new Set([root]),  // canonicalizzato
      worktreesBase: "/private/tmp/wt",
      source: "script",
      status: "running",
      pid: 42,
    })).toBe(false);
  });

  it("cwd sotto la base ma nella root di un'altra worktree viva → SI", () => {
    // La worktree clear-torch e' viva, ma nascent-tamarind no.
    const liveRoot = BASE + "/dancerooms/clear-torch";
    expect(isGhostScript(makeOpts({
      cwdReal: BASE + "/dancerooms/nascent-tamarind/client",
      worktreeRoots: new Set([liveRoot]),
    }))).toBe(true);
  });
});

describe("hasRunningScriptsInWorktree", () => {
  const WPATH = "/home/user/.topics/worktrees/dancerooms/clear-torch";

  it("nessuno script running → false", () => {
    expect(hasRunningScriptsInWorktree({ scripts: [], worktreePath: WPATH })).toBe(false);
  });

  it("script running nel worktree → true", () => {
    expect(hasRunningScriptsInWorktree({
      scripts: [{ processId: "1", pid: 100, projectPath: WPATH + "/client", source: "script", status: "running" }],
      worktreePath: WPATH,
    })).toBe(true);
  });

  it("script running con projectPath UGUALE al worktree → true", () => {
    expect(hasRunningScriptsInWorktree({
      scripts: [{ processId: "1", pid: 100, projectPath: WPATH, source: "script", status: "running" }],
      worktreePath: WPATH,
    })).toBe(true);
  });

  it("script detected (non Topics) → false", () => {
    expect(hasRunningScriptsInWorktree({
      scripts: [{ processId: "1", pid: 100, projectPath: WPATH, source: "detected", status: "running" }],
      worktreePath: WPATH,
    })).toBe(false);
  });

  it("script done → false", () => {
    expect(hasRunningScriptsInWorktree({
      scripts: [{ processId: "1", pid: 100, projectPath: WPATH, source: "script", status: "done" }],
      worktreePath: WPATH,
    })).toBe(false);
  });

  it("script in un altro worktree → false", () => {
    expect(hasRunningScriptsInWorktree({
      scripts: [{ processId: "1", pid: 100, projectPath: BASE + "/dancerooms/nascent-tamarind", source: "script", status: "running" }],
      worktreePath: WPATH,
    })).toBe(false);
  });
});
