/**
 * Le due proprietà che rendono utile la derivazione: 13334 NON deve mai
 * uscire per un worktree (è la porta che si voleva proteggere), e la stessa
 * cartella deve dare sempre la stessa porta (altrimenti ogni run si porterebbe
 * dietro una `DATA_DIR` nuova e un bundle da ricopiare).
 *
 * @covers E2E-LOCK-01
 */
import { describe, it, expect } from "bun:test";
import {
  defaultE2EPort,
  isDispatchWorktree,
  E2E_DEFAULT_PORT,
  WORKTREE_PORT_BASE,
  WORKTREE_PORT_SPAN,
} from "../e2e/helpers/worktree-port";

const HOME = "/Users/tizio";
const WT = (name: string) => `${HOME}/.topics/worktrees/topics-app/${name}`;

describe("isDispatchWorktree", () => {
  it("il checkout principale non è un worktree", () => {
    expect(isDispatchWorktree("/Users/tizio/Projects/topics-app", HOME)).toBe(false);
  });

  it("riconosce un worktree del dispatcher", () => {
    expect(isDispatchWorktree(WT("crested-boulder"), HOME)).toBe(true);
  });

  it("non si fa ingannare da un prefisso che somiglia", () => {
    // `~/.topics/worktrees-backup/x` NON sta dentro `~/.topics/worktrees/`:
    // senza il separatore finale nel confronto, `startsWith` direbbe di sì.
    expect(isDispatchWorktree(`${HOME}/.topics/worktrees-backup/x`, HOME)).toBe(false);
  });
});

describe("defaultE2EPort", () => {
  it("il checkout principale tiene la porta storica", () => {
    expect(defaultE2EPort("/Users/tizio/Projects/topics-app", HOME)).toBe(E2E_DEFAULT_PORT);
  });

  it("un worktree non può MAI ricevere 13334 — è tutto il punto", () => {
    // Tutti i nomi di worktree vivi al momento del fix, più un po' di rumore.
    const names = [
      "crested-boulder", "giant-acorn", "silent-harbor", "amber-thicket",
      "quiet-lantern", "north-willow", "bright-quarry", "hollow-ridge",
      "pale-cinder", "iron-meadow", "swift-orchard", "dusty-anvil",
    ];
    for (let i = 0; i < 500; i++) names.push(`generated-${i}`);
    for (const n of names) {
      const port = defaultE2EPort(WT(n), HOME);
      expect(port).not.toBe(E2E_DEFAULT_PORT);
      expect(port).toBeGreaterThanOrEqual(WORKTREE_PORT_BASE);
      expect(port).toBeLessThan(WORKTREE_PORT_BASE + WORKTREE_PORT_SPAN);
    }
  });

  it("stessa cartella → stessa porta (la DATA_DIR si riusa fra run)", () => {
    const a = defaultE2EPort(WT("crested-boulder"), HOME);
    const b = defaultE2EPort(WT("crested-boulder"), HOME);
    expect(a).toBe(b);
  });

  it("lo slash finale non cambia il checkout, quindi non cambia la porta", () => {
    expect(defaultE2EPort(WT("crested-boulder") + "/", HOME)).toBe(
      defaultE2EPort(WT("crested-boulder"), HOME),
    );
  });

  it("worktree diversi si spargono, non si ammucchiano su una porta", () => {
    const ports = new Set(
      Array.from({ length: 24 }, (_, i) => defaultE2EPort(WT(`wt-${i}`), HOME)),
    );
    // Con 24 estrazioni su 400 slot qualche collisione è statisticamente
    // possibile; un hash che degenera (tutti sullo stesso valore) no.
    expect(ports.size).toBeGreaterThanOrEqual(20);
  });
});
