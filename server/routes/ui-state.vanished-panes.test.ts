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

const chiave = (p: string) => "project:" + encodeURIComponent(p);
let vero: string;

beforeEach(() => {
  vero = join(homedir(), "Projects", "zz-pane-test-" + Date.now());
  mkdirSync(vero, { recursive: true });
});
afterEach(() => rmSync(vero, { recursive: true, force: true }));

describe("dropVanishedProjectPanes", () => {
  it("il pannello della cartella sparita confluisce in quello vero", () => {
    const sparito = join(homedir(), ".openclaw", "workspace", vero.split("/").pop()!);
    const dentro = { panes: { [chiave(sparito)]: { a: 1 }, [chiave(vero)]: { a: 2 } } };
    const fuori = dropVanishedProjectPanes(dentro, "pane-store-v2") as any;
    expect(Object.keys(fuori.panes)).toEqual([chiave(vero)]);
    expect(fuori.panes[chiave(vero)]).toEqual({ a: 2 });
  });

  it("LA FILA DELLE TAB e' cio' che si vedeva doppio: l'id vecchio va rimappato, non lasciato", () => {
    const sparito = join(homedir(), ".openclaw", "workspace", vero.split("/").pop()!);
    const dentro = {
      panes: { [chiave(vero)]: { a: 1 } },
      groups: { "group:default": { paneIds: [chiave(sparito), "terminal:x", chiave(vero)] } },
    };
    const fuori = dropVanishedProjectPanes(dentro, "pane-store-v2") as any;
    expect(fuori.groups["group:default"].paneIds).toEqual([chiave(vero), "terminal:x"]);
  });

  it("rimappa anche un projectPath scritto per esteso, non solo l'id", () => {
    const sparito = join(homedir(), ".openclaw", "workspace", vero.split("/").pop()!);
    const dentro = { panes: { [chiave(vero)]: { a: 1 } }, closedStack: [{ projectPath: sparito }] };
    const fuori = dropVanishedProjectPanes(dentro, "pane-store-v2") as any;
    expect(fuori.closedStack[0].projectPath).toBe(vero);
  });

  it("NON tocca una cartella sparita senza gemello: un disco smontato non perde i pannelli", () => {
    const smontato = "/Volumes/Esterno/progetto-che-non-c-e";
    const dentro = { panes: { [chiave(smontato)]: { a: 1 } } };
    const fuori = dropVanishedProjectPanes(dentro, "pane-store-v2") as any;
    expect(Object.keys(fuori.panes)).toEqual([chiave(smontato)]);
  });

  it("non tocca le altre chiavi né i pannelli non-progetto", () => {
    const dentro = { panes: { "terminal:abc": { a: 1 } } };
    expect(dropVanishedProjectPanes(dentro, "sidebar-state")).toBe(dentro);
    const fuori = dropVanishedProjectPanes(dentro, "pane-store-v2") as any;
    expect(Object.keys(fuori.panes)).toEqual(["terminal:abc"]);
  });
});
