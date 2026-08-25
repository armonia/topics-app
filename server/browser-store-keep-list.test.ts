/**
 * @covers KEEPLIST-01
 */
import { test, expect } from "bun:test";
import { collectBrowserContextIds } from "./browser-store-keep-list";

test("una pane browser nel layout protegge il suo store", () => {
  const paneStore = JSON.stringify({
    panes: { "browser:ctx-abc": { id: "browser:ctx-abc", type: "browser" } },
    groups: { "group:default": { paneIds: ["browser:ctx-abc", "terminal:t1"] } },
  });
  expect(collectBrowserContextIds([paneStore])).toEqual(["ctx-abc"]);
});

test("la tab consegnata da un task protegge il suo store, e anche il gemello _ws", () => {
  // `task-browser-tabs:<taskId>` non usa la forma `browser:<id>`: il ctx è un
  // campo. Leggere solo le pane avrebbe lasciato scoperte tutte le consegne.
  const taskTabs = JSON.stringify({
    tabs: [
      { contextId: "task-tab-1", url: "https://x", title: "App" },
      { contextId: "task-tab-1_ws", url: "https://y", title: "Report" },
    ],
    activeContextId: "task-tab-1",
  });
  expect(collectBrowserContextIds([taskTabs])).toEqual(["task-tab-1", "task-tab-1_ws"]);
});

test("un ctx che è un path torna con le barre vere, non con quelle scappate", () => {
  // Il ctx di una pane di progetto È il path, e lo store si chiama con l'hash
  // di quella stringa: restituire `\/Users\/...` cercherebbe uno store che non
  // esiste, cioè dichiarerebbe orfano uno store vivo.
  const blob = '{"panes":{"browser:\\/Users\\/me\\/progetto":{}}}';
  expect(collectBrowserContextIds([blob])).toEqual(["/Users/me/progetto"]);
});

test("le righe si sommano e i duplicati collassano", () => {
  const a = JSON.stringify({ panes: { "browser:uno": {} } });
  const b = JSON.stringify({ tabs: [{ contextId: "uno" }, { contextId: "due" }] });
  expect(collectBrowserContextIds([a, b])).toEqual(["due", "uno"]);
});

test("una riga corrotta protegge comunque quello che nomina", () => {
  // `JSON.parse` su questa riga fallirebbe: con un parser vero il suo store
  // sparirebbe dalla lista in silenzio, e col silenzio se ne andrebbe il login.
  const troncata = '{"panes":{"browser:sopravvissuto":{"url":"https://x"';
  expect(collectBrowserContextIds([troncata])).toEqual(["sopravvissuto"]);
});

test("nessuna riga, nessun permesso — e nessun errore", () => {
  expect(collectBrowserContextIds([])).toEqual([]);
  expect(collectBrowserContextIds(["", "{}", "non json"])).toEqual([]);
});

test("le regex non tengono stato fra due chiamate", () => {
  // Sono globali e module-level: senza azzerare `lastIndex` la seconda chiamata
  // ripartirebbe da metà stringa e perderebbe i primi ctx — cioè toglierebbe
  // protezione a caso, a seconda di chi ha chiamato prima.
  const blob = JSON.stringify({ panes: { "browser:stabile": {} } });
  expect(collectBrowserContextIds([blob])).toEqual(["stabile"]);
  expect(collectBrowserContextIds([blob])).toEqual(["stabile"]);
});
