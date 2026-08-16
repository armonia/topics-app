import { expect, test } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * ADD-MENU — il menu "New…" come SISTEMA, non come utility.
 *
 * Venti spec usano già questo menu per creare pane, ma nessuna verificava il
 * menu in sé: erano tutte click ciechi su un testid. In quel punto cieco sono
 * vissuti tre difetti insieme (audit 2026-08-06):
 *
 *   1. "New Chat" spariva da TUTTI e sei gli host quando `enableNewChat` era
 *      salvato a false — un flag di preferenza che poteva solo rompere.
 *   2. ⌘N non chiudeva niente: un dropdown aperto restava su e la palette si
 *      aggiungeva alla pila. Misurato: 1 menu → ⌘N → 2 menu contemporanei.
 *   3. La palette era `z-[60]` contro i 9999 di ogni popover: finiva SOTTO il
 *      dropdown rimasto aperto, e sotto il proprio velo.
 *
 * Più il debito che li rendeva possibili: il menu non passava dalla primitiva
 * `Menu`, quindi niente `role="menu"`, niente fuoco nel pannello, niente
 * frecce — e senza fuoco nel pannello le lettere non sarebbero intercettabili.
 */

/**
 * L'APP PRONTA, E NIENTE APERTO SOPRA.
 *
 * Ogni caso qui dentro apriva con `goToApp` + `Escape`, e quell'Escape e' un
 * colpo alla cieca: parte anche se non c'e' niente da chiudere, e soprattutto
 * NON aspetta che qualcosa si sia chiuso. Sotto carico (la nightly, quattro
 * shard sulla stessa macchina) la palette faceva in tempo a montarsi DOPO
 * l'Escape, e il caso successivo la trovava aperta - da cui un rosso che si
 * spostava di file in file senza che nessun test fosse rotto:
 *   run 31925599726 / 31968457939 -> ADD-09
 *   run 31970135356               -> ADD-05
 *
 * Qui si aspetta uno stato, non un istante: l'app viva, e nessun pannello
 * sopra. L'Escape si ripete finche' non e' vero, che e' diverso da premerlo
 * una volta e sperare.
 */
async function appPulita(page: import("@playwright/test").Page) {
  await goToApp(page);
  const sovrapposti = page.locator(
    '[data-testid="pane-add-palette"], [data-testid="pane-add-menu"], [data-testid="command-palette"]',
  );
  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(sovrapposti).toHaveCount(0, { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
}

const PROJECT_DIR = "/tmp/e2e-add-menu";

test.describe.serial("Add menu — sistema", () => {
  let topicId: string | null = null;

  test.beforeAll(async ({ request }) => {
    const topic = await createTopic(request, "E2E-AddMenu", { projectPath: PROJECT_DIR });
    topicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test("ADD-01: New Chat c'è, e non dipende da nessun interruttore", async ({ page, request }) => {
    // Il gate `enableNewChat` è stato rimosso: anche seminando il valore che
    // PRIMA lo spegneva, la riga deve esserci. È il pin del bug 1 — un client
    // con quel false salvato mostrava sette voci su otto e nessuna diagnosi.
    await resetPaneStore(request, []);
    await page.addInitScript(() =>
      localStorage.setItem("app-settings", JSON.stringify({ enableNewChat: false })),
    );
    await appPulita(page);

    await page.getByTestId("pane-add-menu-trigger").first().click();
    const menu = page.getByTestId("pane-add-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("pane-add-menu-new-chat")).toBeVisible();
    // …e le voci che ⌘K non offriva prima dell'unificazione.
    await expect(menu.getByTestId("pane-add-menu-opencode")).toBeVisible();
    await expect(menu.getByTestId("pane-add-menu-browser")).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("ADD-02: ⌘N non impila — un solo menu aperto alla volta", async ({ page, request }) => {
    // Serve una tab bar, cioè una pane aperta: il "+" della barra è un
    // DROPDOWN, mentre quello dell'header è la palette che ⌘N stessa apre —
    // partire da lì misurerebbe un toggle, non l'impilamento.
    await resetPaneStore(request, [topicId!]);
    await appPulita(page);

    const tabBarPlus = page.locator('[data-testid="pane-add-menu-trigger"][title="Add pane"]').first();
    await expect(tabBarPlus).toBeVisible({ timeout: 10_000 });
    await tabBarPlus.click();
    await expect(page.getByTestId("pane-add-menu")).toHaveCount(1);
    await expect(page.getByTestId("pane-add-palette")).toHaveCount(0);

    // …poi ⌘N. Prima erano DUE menu insieme, col dropdown disegnato sopra la
    // palette. Ora il dropdown cede il posto. Regola: lib/popoverRegistry.
    await page.keyboard.press("Meta+n");
    await expect(page.getByTestId("pane-add-palette")).toBeVisible();
    await expect(page.getByTestId("pane-add-menu")).toHaveCount(1);
  });

  test("ADD-03: la palette sta SOPRA i popover, non sotto", async ({ page, request }) => {
    await resetPaneStore(request, []);
    await appPulita(page);

    await page.keyboard.press("Meta+n");
    const palette = page.getByTestId("pane-add-palette");
    await expect(palette).toBeVisible();

    // Il numero, non l'apparenza: un popover vale Z_POPOVER (9999), un modale
    // Z_MODAL (10000). Con `z-[60]` la palette finiva 9939 sotto un dropdown.
    const z = await palette.evaluate((el) => parseInt(getComputedStyle(el).zIndex, 10));
    expect(z).toBeGreaterThan(9999);
    await page.keyboard.press("Escape");
  });

  test("ADD-04: il menu è un menu — role, fuoco e frecce", async ({ page, request }) => {
    await resetPaneStore(request, []);
    await appPulita(page);

    const trigger = page.getByTestId("pane-add-menu-trigger").first();
    await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");

    const menu = page.getByTestId("pane-add-menu");
    await expect(menu).toHaveAttribute("role", "menu");

    // Il fuoco entra nel pannello: è il prerequisito delle lettere, non un
    // dettaglio a11y. Senza, un tasto nudo non arriverebbe mai al menu.
    const focusInside = await menu.evaluate(
      (el) => el === document.activeElement || el.contains(document.activeElement),
    );
    expect(focusInside).toBe(true);

    // ↓ porta il fuoco sulla prima riga.
    await page.keyboard.press("ArrowDown");
    const onRow = await page.evaluate(() =>
      document.activeElement?.getAttribute("data-testid")?.startsWith("pane-add-menu-") ?? false,
    );
    expect(onRow).toBe(true);
    await page.keyboard.press("Escape");
  });

  test("ADD-05: la lettera nuda apre la voce — ⌘N poi B = browser", async ({ page, request }) => {
    await resetPaneStore(request, []);
    await appPulita(page);

    await page.keyboard.press("Meta+n");
    await expect(page.getByTestId("pane-add-palette")).toBeVisible();

    // La riga dichiara la sua lettera in modo verificabile, non solo dipinta.
    await expect(page.getByTestId("pane-add-menu-browser")).toHaveAttribute("data-mnemonic", "B");
    await page.keyboard.press("b");

    await expect(page.getByTestId("browser-url-input")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("pane-add-palette")).toHaveCount(0);
  });

  test("ADD-07: il chip è disegnato dove è stato deciso — a destra, uno per riga", async ({ page, request }) => {
    // Misura, non impressione: il repo giudica la geometria dal DOM, non da un
    // pixel. Quello che va pinnato è che la lettera esista come elemento, sia
    // UNA sola per riga, e stia nella colonna destra — cioè il disegno scelto
    // (chip .kbd a fine riga), non uno qualunque che «sembra giusto».
    await resetPaneStore(request, []);
    await appPulita(page);

    await page.keyboard.press("Meta+n");
    await expect(page.getByTestId("pane-add-palette")).toBeVisible();

    const rows = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="pane-add-menu"]')!;
      const box = panel.getBoundingClientRect();
      return Array.from(panel.querySelectorAll<HTMLElement>('[data-testid^="pane-add-menu-"]')).map((row) => {
        const kbds = row.querySelectorAll("kbd");
        const label = row.querySelector("span");
        const r = row.getBoundingClientRect();
        const k = kbds[0]?.getBoundingClientRect();
        return {
          testid: row.getAttribute("data-testid"),
          kbdCount: kbds.length,
          // distanza del chip dal bordo destro della riga
          gapRight: k ? Math.round(r.right - k.right) : null,
          // il chip sta DOPO l'etichetta, non prima
          afterLabel: !!(k && label) && k.left >= label!.getBoundingClientRect().right,
          overflows: Math.round(r.right) > Math.round(box.right) + 1,
        };
      });
    });

    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) {
      expect(r.kbdCount, `${r.testid}: un chip e uno solo`).toBe(1);
      expect(r.afterLabel, `${r.testid}: il chip sta a destra dell'etichetta`).toBe(true);
      // Stessa colonna per tutte: il padding di riga è px-3 (12px).
      expect(r.gapRight, `${r.testid}: chip incollato al bordo destro`).toBeLessThanOrEqual(14);
      expect(r.overflows, `${r.testid}: la riga non sfora il pannello`).toBe(false);
    }
    await page.keyboard.press("Escape");
  });

  test("ADD-08: un solo corpo tipografico per superficie, e niente intestazione", async ({ page, request }) => {
    // La palette e' portata su `document.body`, FUORI dal wrapper dove App
    // scrive `fontSize`: ogni testo senza classe di dimensione ricade sui 16px
    // di default del browser. Ci era cascato l'header — chip ESC a 16px accanto
    // a lettere da 12px — e la stessa trappola aspetta chiunque aggiunga testo
    // a un pannello portato. Il gate misura la CLASSE, non l'istanza.
    await resetPaneStore(request, []);
    await appPulita(page);
    await page.keyboard.press("Meta+n");
    await expect(page.getByTestId("pane-add-palette")).toBeVisible();

    const sizes = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="pane-add-menu"]')!;
      return Array.from(panel.querySelectorAll("kbd")).map((k) => getComputedStyle(k).fontSize);
    });
    expect(sizes.length).toBeGreaterThan(5);
    expect(new Set(sizes).size, `corpi diversi: ${[...new Set(sizes)].join(", ")}`).toBe(1);

    // E l'intestazione non torna: questa e' una lista d'azione, non una
    // palette di ricerca — il titolo ripeteva cosa fosse e il chip ESC
    // ricordava un tasto che sanno tutti.
    await expect(page.getByTestId("pane-add-menu")).not.toContainText("ESC");
  });

  test("ADD-09: \u2318K e il menu \u00ab+\u00bb offrono la STESSA lista, o \u00e8 rosso", async ({ page, request }) => {
    // Il gate che rende vera la parola \u00abinsieme\u00bb. Il modello \u00e8 gi\u00e0 condiviso,
    // ma finch\u00e9 una delle due superfici poteva RESTRINGERLO a mano \u2014 c'era un
    // `COMMAND_PALETTE_PILL_IDS` \u2014 la deriva poteva ripartire in silenzio: un
    // tipo di pane nuovo sarebbe comparso nel menu e non in \u2318K, esattamente
    // come era gi\u00e0 successo con opencode, Browser e Board.
    //
    // Confronto per ID, non per etichetta: gli id sono il contratto, i testi
    // cambiano (e sono appena cambiati \u2014 \u00abNew Chat\u00bb \u2192 \u00abChat\u00bb).
    await resetPaneStore(request, []);
    await appPulita(page);

    await page.keyboard.press("Meta+n");
    await expect(page.getByTestId("pane-add-palette")).toBeVisible();
    const menuIds = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="pane-add-menu"] [data-testid^="pane-add-menu-"]'))
        .map((el) => el.getAttribute("data-testid")!.replace("pane-add-menu-", ""))
        .sort(),
    );
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("pane-add-palette")).toHaveCount(0);

    await page.keyboard.press("Meta+k");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    const pillIds = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="cmdk-add-"]'))
        .map((el) => el.getAttribute("data-testid")!.replace("cmdk-add-", ""))
        .sort(),
    );

    expect(pillIds.length).toBeGreaterThan(5);
    expect(pillIds, "\u2318K e il menu \u00ab+\u00bb devono offrire lo stesso insieme").toEqual(menuIds);

    // E la barra dei comandi in fondo sta su UNA riga. Andava a capo perche'
    // portava anche le otto voci di creazione: \u00abbrutto\u00bb e' un'impressione,
    // due `offsetTop` diversi sono un numero. Ora le voci sono righe cercabili
    // e la barra tiene solo i comandi globali.
    const barRows = await page.evaluate(() => {
      const pills = Array.from(
        document.querySelectorAll('[data-testid="command-palette"] button'),
      ).filter((b) => (b as HTMLElement).closest("section") === null && (b as HTMLElement).offsetParent !== null);
      const bar = pills.filter((b) => !b.hasAttribute("data-cmd-idx"));
      const tops = new Set(bar.map((b) => Math.round(b.getBoundingClientRect().top)));
      return { count: bar.length, rows: tops.size };
    });
    expect(barRows.count).toBeGreaterThan(0);
    expect(barRows.rows, "la barra dei comandi non deve andare a capo").toBe(1);
    await page.keyboard.press("Escape");
  });

  test("ADD-06: il chip non entra nel nome accessibile della riga", async ({ page, request }) => {
    // Se il chip finisse nel nome accessibile la riga si chiamerebbe
    // "Terminale T", e ogni locator per nome esatto smetterebbe di trovarla.
    // Per gli screen reader la lettera passa da `aria-keyshortcuts`.
    //
    // La riga si chiama «Terminale», ma il suo testid resta
    // `pane-add-menu-shell`: l'ID è il contratto E2E (e la chiave del CHECK di
    // SQLite lato sessioni), la parola è solo la parola. È esattamente la
    // distinzione che questo test tiene in piedi.
    await resetPaneStore(request, []);
    await appPulita(page);

    await page.getByTestId("pane-add-menu-trigger").first().click();
    const shell = page.getByTestId("pane-add-menu-shell");
    await expect(shell).toBeVisible();
    await expect(shell).toHaveAttribute("aria-keyshortcuts", "T");
    const name = await shell.evaluate((el) => (el.textContent || "").trim());
    // Il chip è nel testo (`aria-hidden` non lo toglie da textContent), ma NON
    // nel nome accessibile: la riga si chiama ancora esattamente "Terminale".
    expect(name.startsWith("Terminale")).toBe(true);
    await expect(page.getByRole("menuitem", { name: "Terminale", exact: true })).toHaveCount(1);
    await page.keyboard.press("Escape");
  });

  test("ADD-10: l'ordine del menu è quello deciso, e la linea sta prima degli agenti", async ({ page, request }) => {
    // L'ordine era un effetto collaterale, non una scelta: il ramo `terminal`
    // di buildAddMenuItems emetteva i QUATTRO agenti in blocco, quindi Browser
    // e Board finivano per forza dopo Claude Code — e Board finiva addirittura
    // in coda, perché `kanban` non era in CURATED_ORDER. Nessun test lo
    // guardava, quindi non era una decisione: era ciò che capitava.
    //
    // Ora l'ordine è dichiarato e questo è il suo cancello: prima le pane che
    // si aprono vuote (Chat, Terminale, Browser, Board, Git, Files), poi una
    // linea, poi gli agenti CLI — che aprono una sessione con un modello
    // dentro, e sono un'altra categoria di cosa.
    await resetPaneStore(request, []);
    await appPulita(page);

    await page.keyboard.press("Meta+n");
    await expect(page.getByTestId("pane-add-palette")).toBeVisible();

    // Righe E divisori nell'ordine del DOM. Il divisore è un `<div>` fratello
    // della riga (`POPOVER_DIVIDER` = `my-1 h-px bg-app-border`), quindi va
    // letto insieme alle righe: senza, «la linea sta PRIMA di Claude Code» non
    // sarebbe una misura, sarebbe un'impressione.
    const seq = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="pane-add-menu"]')!;
      return Array.from(
        panel.querySelectorAll('[data-testid^="pane-add-menu-"], .h-px'),
      ).map((el) => {
        const tid = el.getAttribute("data-testid");
        return tid ? tid.replace("pane-add-menu-", "") : "---";
      });
    });

    // Le tre voci che il registro condiviso marca come agenti CLI. `shell` NON
    // è tra queste: è una pane che si apre vuota, e sta sopra la linea.
    const AGENTS = ["claude-code", "codex", "opencode"];
    const agentIdx = seq.flatMap((id, i) => (AGENTS.includes(id) ? [i] : []));
    expect(agentIdx.length, "i tre agenti CLI sono nel menu").toBe(3);

    // 1. Gli agenti sono un BLOCCO in coda: nessuna riga non-agente dopo il
    //    primo di loro. È l'invariante che il vecchio ramo atomico rendeva
    //    impossibile — con quattro agenti emessi insieme, Browser e Board
    //    finivano per forza dopo Claude Code.
    const firstAgent = agentIdx[0];
    const strays = seq.slice(firstAgent).filter((id) => id !== "---" && !AGENTS.includes(id));
    expect(strays, "sotto la linea ci vanno SOLO gli agenti").toEqual([]);

    // 2. Restano nell'ordine del registro condiviso (TERMINAL_AGENT_TYPES).
    expect(agentIdx.map((i) => seq[i])).toEqual(AGENTS);

    // 3. La linea sta ESATTAMENTE prima del primo agente.
    expect(seq[firstAgent - 1], "un divisore apre il blocco degli agenti").toBe("---");

    // 4. E «Terminale» sta sopra la linea, prima di Browser: è una pane, non un
    //    agente. Il testid resta `shell` — l'id è il contratto, la parola no.
    const shellIdx = seq.indexOf("shell");
    const browserIdx = seq.indexOf("browser");
    expect(shellIdx).toBeGreaterThan(-1);
    expect(browserIdx).toBeGreaterThan(shellIdx);
    expect(browserIdx).toBeLessThan(firstAgent);

    await page.keyboard.press("Escape");
  });
});
