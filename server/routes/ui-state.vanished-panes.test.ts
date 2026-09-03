/**
 * The pane of a vanished folder, when the real one is already there.
 *
 * Happened on 02/09/2026: a project reached through a symlink had two panes.
 * Cleaning the DB was not enough — the client pushed its `pane-store-v2` back
 * from localStorage and the duplicate returned ten minutes later. So the filter
 * sits on the WRITE, and the «only if the twin is there» condition is what stops
 * an unmounted external disk from losing its panes.
 *
 * @covers PROJ-ID-03
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { dropVanishedProjectPanes } from "./ui-state";

const paneKey = (p: string) => "project:" + encodeURIComponent(p);
let realDir: string;

beforeEach(() => {
  realDir = join(homedir(), "Projects", "zz-pane-test-" + Date.now());
  mkdirSync(realDir, { recursive: true });
});
afterEach(() => rmSync(realDir, { recursive: true, force: true }));

describe("dropVanishedProjectPanes", () => {
  it("il pannello della cartella sparita confluisce in quello vero", () => {
    const vanished = join(homedir(), ".openclaw", "workspace", realDir.split("/").pop()!);
    const input = { panes: { [paneKey(vanished)]: { a: 1 }, [paneKey(realDir)]: { a: 2 } } };
    const output = dropVanishedProjectPanes(input, "pane-store-v2") as any;
    expect(Object.keys(output.panes)).toEqual([paneKey(realDir)]);
    expect(output.panes[paneKey(realDir)]).toEqual({ a: 2 });
  });

  it("LA FILA DELLE TAB e' cio' che si vedeva doppio: l'id vecchio va rimappato, non lasciato", () => {
    const vanished = join(homedir(), ".openclaw", "workspace", realDir.split("/").pop()!);
    const input = {
      panes: { [paneKey(realDir)]: { a: 1 } },
      groups: { "group:default": { paneIds: [paneKey(vanished), "terminal:x", paneKey(realDir)] } },
    };
    const output = dropVanishedProjectPanes(input, "pane-store-v2") as any;
    expect(output.groups["group:default"].paneIds).toEqual([paneKey(realDir), "terminal:x"]);
  });

  it("rimappa anche un projectPath scritto per esteso, non solo l'id", () => {
    const vanished = join(homedir(), ".openclaw", "workspace", realDir.split("/").pop()!);
    const input = { panes: { [paneKey(realDir)]: { a: 1 } }, closedStack: [{ projectPath: vanished }] };
    const output = dropVanishedProjectPanes(input, "pane-store-v2") as any;
    expect(output.closedStack[0].projectPath).toBe(realDir);
  });

  it("NON tocca una cartella sparita senza gemello: un disco smontato non perde i pannelli", () => {
    const unmounted = "/Volumes/Esterno/progetto-che-non-c-e";
    const input = { panes: { [paneKey(unmounted)]: { a: 1 } } };
    const output = dropVanishedProjectPanes(input, "pane-store-v2") as any;
    expect(Object.keys(output.panes)).toEqual([paneKey(unmounted)]);
  });

  it("non tocca le altre chiavi né i pannelli non-progetto", () => {
    const input = { panes: { "terminal:abc": { a: 1 } } };
    expect(dropVanishedProjectPanes(input, "sidebar-state")).toBe(input);
    const output = dropVanishedProjectPanes(input, "pane-store-v2") as any;
    expect(Object.keys(output.panes)).toEqual(["terminal:abc"]);
  });
});
