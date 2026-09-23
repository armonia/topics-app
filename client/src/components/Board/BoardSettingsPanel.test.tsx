/**
 * AICTRL-05: due difetti veri, eseguiti e non letti nel sorgente. Un `!!` sul default della board collassava a OFF una board mai toccata col prefisso legacy acceso; e un toggle che si portasse dietro `dispatchModel` fonderebbe due assi separati. allow-italian: i due difetti che il file impedisce
 * Il pannello si monta davvero (`renderToStaticMarkup`), ma la riga dello switch vive in un `Menu` chiuso al primo paint: il mount prova che la risoluzione gira, il comportamento del toggle si esegue su `boardTopicsRoutingSwitch`. allow-italian: dice cosa prova il mount e cosa no
 * @covers AICTRL-05
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardSettingsPanel } from "./BoardSettingsPanel";
import { boardTopicsRoutingSwitch } from "../../lib/topicsRoutingGate";
import type { BoardSettings } from "../../lib/board";

const SETTINGS = {
  projectId: "p1", autoDispatch: true, dispatchEffort: "medium", dispatchUseWorktree: true,
  dispatchAutoMerge: false, deployCommand: "", dispatchTimeoutMin: 20, dispatchIdleMin: 5,
  dispatchMcp: "bridge-only", dispatchModel: "topics:claude-opus-5", dispatchFanOut: 1,
  dispatchPaused: false, dispatchTopicsRouting: null, reviewChecks: [], responseLanguage: null,
  nightMode: false, nightModeUntil: null, requireApprovalForDone: false, requireReviewBeforeDone: false,
  blockStatusWithPending: false, onlyLeadCanChangeStatus: false, autoExpireHours: 24,
} as unknown as BoardSettings;

function mount(settings: BoardSettings): string {
  return renderToStaticMarkup(
    <BoardSettingsPanel
      projectId="p1"
      settings={settings}
      dispatchOn
      models={["claude-opus-5"]}
      onToggleDispatch={() => {}}
      onChanged={() => {}}
      onClose={() => {}}
      onError={() => {}}
    />,
  );
}

describe("BoardSettingsPanel monta lo switch di instradamento", () => {
  test("il pannello si disegna con la nuova risoluzione, board legacy inclusa", () => {
    expect(mount(SETTINGS)).toContain('data-testid="board-settings-panel"');
    expect(mount({ ...SETTINGS, dispatchTopicsRouting: false } as BoardSettings))
      .toContain('data-testid="board-settings-panel"');
  });

  test("board mai toccata col prefisso legacy: lo switch si legge ON", () => {
    expect(boardTopicsRoutingSwitch(SETTINGS, () => {}).enabled).toBe(true);
    expect(boardTopicsRoutingSwitch({ ...SETTINGS, dispatchModel: "claude-opus-5" }, () => {}).enabled).toBe(false);
  });

  test("una scelta esplicita batte sempre il prefisso legacy", () => {
    expect(boardTopicsRoutingSwitch({ ...SETTINGS, dispatchTopicsRouting: false }, () => {}).enabled).toBe(false);
    expect(boardTopicsRoutingSwitch({ dispatchTopicsRouting: true, dispatchModel: "claude-opus-5" }, () => {}).enabled).toBe(true);
  });

  test("il toggle patcha SOLO il proprio asse, mai dispatchModel", () => {
    const patches: Record<string, unknown>[] = [];
    boardTopicsRoutingSwitch(SETTINGS, (p) => { patches.push(p); }).onToggle(false);

    expect(patches).toEqual([{ dispatchTopicsRouting: false }]);
    expect(Object.keys(patches[0]!)).toEqual(["dispatchTopicsRouting"]);
  });
});

describe("il filo fra il pannello e il menu", () => {
  // Secondario: prova solo che lo switch sta sulla STESSA istanza del menu, non che qualcuno ne abbia cablato un secondo a mano. allow-italian: dice il confine di questa prova
  const src = readFileSync(join(import.meta.dir, "BoardSettingsPanel.tsx"), "utf8");

  test("un solo switch, e sta su TaskModelMenuOptions", () => {
    const menuStart = src.indexOf("<TaskModelMenuOptions");
    expect(menuStart).toBeGreaterThan(0);
    expect(src.slice(menuStart, src.indexOf("/>", menuStart))).toContain("topicsRouting={topicsRoutingSwitch}");
    expect((src.match(/topicsRouting=/g) ?? []).length).toBe(1);
  });
});
