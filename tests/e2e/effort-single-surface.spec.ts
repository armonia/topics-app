/**
 * @covers EFFORTUI-01
 */
import { expect, test } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, patchTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * PIANO §1b.1 + §1b.2 — l'effort si cambia in UN posto solo, ed è uno slider.
 *
 * 1b.1: viveva in due superfici — il popover del modello e il
 *       SessionConfigPopover — con due grafiche e due idee di "default".
 *       Nel picker del modello adesso non resta NIENTE dell'effort: né il badge
 *       del valore in forza, né il tier che il provider forza sulle sue
 *       sessioni. Quel bottone apre la lista dei modelli e parla di modelli.
 * 1b.2: cinque pill non dicono che `max` viene dopo `xhigh`. La scala è
 *       ordinata: si guida con uno slider.
 */
test.describe.serial("Effort — una sola superficie, uno slider", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = "Effort UI " + Date.now();
    const t = await createTopic(request, topicName);
    topicId = t.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    // Anche provider/model: il file è `serial`, e il test sul badge 1M lascia una
    // scelta di modello sulla topic. Ripulire in coda al test non basta — se
    // quello fallisce a metà, l'avanzo avvelenerebbe i successivi.
    await patchTopic(request, topicId, { effort: null, provider: null, model: null });
    await resetPaneStore(request, [topicId]);
  });

  test("il picker del modello non offre più i bottoni dell'effort", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "EFFORTUI-01" });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const picker = page.getByTestId("provider-model-picker");
    await picker.waitFor({ state: "visible", timeout: 10_000 });
    await picker.click();
    const popover = page.locator('[data-popover="provider-model-picker"]');
    await popover.waitFor({ state: "visible", timeout: 5_000 });

    // Nessuno dei cinque bottoni di prima, e nessuna label "Effort" dentro il
    // popover del modello: quel pannello parla di provider e modelli.
    for (const tier of ["low", "medium", "high", "xhigh", "max"]) {
      await expect(popover.getByTestId(`effort-opt-${tier}`)).toHaveCount(0);
    }
    await expect(popover.getByRole("group", { name: "Reasoning effort tier" })).toHaveCount(0);

    // E nemmeno l'effort in SOLA LETTURA. Erano rimasti due badge: il tier in
    // forza sul bottone, e quello del provider accanto a ogni intestazione di
    // gruppo. Leggerli lì significava cercare l'effort nel controllo sbagliato —
    // il difetto che questa spec esiste per chiudere. Ora si legge in un posto
    // solo, il pannello che lo cambia.
    await expect(page.getByTestId("effort-tier-badge")).toHaveCount(0);
    for (const prov of ["claude-code", "claude", "codex", "openai", "openclaw"]) {
      await expect(popover.getByTestId(`effort-tier-${prov}`)).toHaveCount(0);
    }
  });

  test("lo slider nel pannello di sessione scrive l'override sulla topic", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "EFFORTUI-01" });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    await page.getByTestId("chat-session-config").click();
    const panel = page.getByTestId("chat-session-config-panel");
    await panel.waitFor({ state: "visible", timeout: 5_000 });

    const slider = panel.getByTestId("session-effort-slider");
    await expect(slider).toBeVisible();
    // Nessun override ancora: il pollice sta sul default, non su un valore
    // scelto dall'umano.
    await expect(slider).not.toHaveAttribute("data-effort-overridden", "true");

    // `low` è il primo tier della scala: qualunque sia il default del provider
    // in questo ambiente, portarcisi sopra è un override esplicito.
    await slider.fill("0");
    await expect(slider).toHaveAttribute("data-effort-tier", "low");
    await expect(slider).toHaveAttribute("data-effort-overridden", "true");

    // …e finisce sul server, non solo nel DOM. Non esiste una GET per la
    // singola topic (solo la PATCH): la verità sta nell'elenco.
    await expect
      .poll(async () => {
        const res = await request.get(`/api/topics`);
        if (!res.ok()) return undefined;
        const data = (await res.json()) as { topics?: Record<string, { effort?: string | null }> };
        return data.topics?.[topicId]?.effort;
      }, { timeout: 10_000 })
      .toBe("low");
  });

  test("l'effort si VEDE sul controllo che lo cambia, sempre", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "EFFORTUI-01" });
    // Il difetto segnalato: «un tasto per l'effort che cambia la label dall'altra
    // select». L'override finiva scritto nel bottone del MODELLO — che apre la
    // lista dei modelli — mentre a cambiarlo era il pannello di sessione, che al
    // suo posto mostrava un'icona di cursori: un bottone senza nessun segno di
    // cosa governasse. Ora il valore sta AL POSTO dell'icona, sul trigger che lo
    // cambia, e ci sta anche quando nessuno ha scelto niente.
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const trigger = page.getByTestId("chat-session-config");
    await trigger.waitFor({ state: "visible", timeout: 10_000 });
    const badge = trigger.getByTestId("session-effort-badge");

    // Senza override si legge comunque il tier in forza — quello del provider —
    // ed è marcato come tale: il badge non dice solo QUANTO, dice anche CHI l'ha
    // deciso. (Se questo ambiente ha un provider senza tier il badge non c'è: in
    // quel caso non esiste un effort in forza da mostrare, e inventarne uno
    // sarebbe peggio del silenzio.)
    const hadDefault = (await badge.count()) > 0;
    if (hadDefault) await expect(badge).toHaveAttribute("data-effort-source", "default");

    await trigger.click();
    const slider = page.getByTestId("chat-session-config-panel").getByTestId("session-effort-slider");
    await slider.fill("0");
    await page.keyboard.press("Escape");

    await expect(badge).toHaveText("low", { timeout: 5_000 });
    await expect(badge).toHaveAttribute("data-effort-source", "override");
  });

  test("cambiare effort non sposta di un pixel la barra del composer", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "EFFORTUI-01" });
    // Il layout shift segnalato. Le sigle dei tier hanno lunghezze diverse (LOW 3,
    // MEDIUM 6, XHIGH 5): a larghezza libera ogni cambio allargava o stringeva il
    // bottone e trascinava con sé quello che gli sta intorno. Qui si MISURA, non
    // si guarda: stessa scatola prima e dopo.
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const trigger = page.getByTestId("chat-session-config");
    const picker = page.getByTestId("provider-model-picker");
    await trigger.waitFor({ state: "visible", timeout: 10_000 });
    await picker.waitFor({ state: "visible", timeout: 10_000 });

    // IL PASSAGGIO CHE NON ERA MAI STATO MISURATO: da nessun override al primo
    // override. Le due misure di sotto partivano entrambe da un override già
    // messo, quindi il salto peggiore — quello in cui il badge NASCE, o cambia
    // aspetto — restava fuori dalla rete. È anche il primo che vede chi usa
    // l'app, perché una chat nuova non ha override.
    const boxPristine = await trigger.boundingBox();
    if (!boxPristine) throw new Error("composer non misurabile");

    await trigger.click();
    const slider = page.getByTestId("chat-session-config-panel").getByTestId("session-effort-slider");
    await slider.fill("0");
    await expect(slider).toHaveAttribute("data-effort-tier", "low");
    await page.keyboard.press("Escape");
    await expect(trigger.getByTestId("session-effort-badge")).toHaveText("low", { timeout: 5_000 });

    const boxLow = await trigger.boundingBox();
    const pickerLow = await picker.boundingBox();
    if (!boxLow || !pickerLow) throw new Error("composer non misurabile");

    // Lo slot del badge ha larghezza fissa e ospita anche l'icona di ripiego:
    // mettere il primo override non deve muovere il bottone di un pixel.
    expect(boxLow.width).toBeCloseTo(boxPristine.width, 1);
    expect(boxLow.x).toBeCloseTo(boxPristine.x, 1);

    // `medium` è la sigla più lunga della scala: se una larghezza fissa non ci
    // fosse, il salto si vedrebbe proprio qui.
    await trigger.click();
    await slider.fill("1");
    await expect(slider).toHaveAttribute("data-effort-tier", "medium");
    await page.keyboard.press("Escape");
    await expect(trigger.getByTestId("session-effort-badge")).toHaveText("medium", { timeout: 5_000 });

    const boxMedium = await trigger.boundingBox();
    const pickerMedium = await picker.boundingBox();
    if (!boxMedium || !pickerMedium) throw new Error("composer non misurabile");

    expect(boxMedium.width).toBeCloseTo(boxLow.width, 1);
    expect(boxMedium.x).toBeCloseTo(boxLow.x, 1);
    // Il picker sta a SINISTRA del trigger: qualunque cosa lo faccia cambiare di
    // larghezza al cambio di effort farebbe scivolare il trigger — lo stesso
    // shift, dall'altro lato. Oggi il picker non mostra più niente che dipenda
    // dall'effort, e questa misura è ciò che tiene ferma quella separazione.
    expect(pickerMedium.width).toBeCloseTo(pickerLow.width, 1);
  });

  test("la finestra del modello si legge in un badge, non in un suffisso tagliato", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "EFFORTUI-01" });
    // `claude-opus-5[1m]` finiva dentro uno span `truncate` accanto al nome: su
    // una pane stretta veniva tagliato via proprio il suffisso, cioè l'unica cosa
    // che distingue 200k da 1M. Ora la modalità è un badge a sé.
    await patchTopic(request, topicId, { provider: "claude-code", model: "claude-opus-5[1m]" });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const picker = page.getByTestId("provider-model-picker");
    await picker.waitFor({ state: "visible", timeout: 10_000 });
    // L'identità resta l'id ESATTO della CLI, suffisso compreso: è quello che
    // viene mandato al provider, e non deve essere ricostruito dall'etichetta.
    await expect(picker).toHaveAttribute("data-model", "claude-opus-5[1m]", { timeout: 10_000 });
    await expect(picker.getByTestId("model-context-badge")).toHaveText("1M");
    // …e il nome accanto non porta più le parentesi.
    await expect(picker).not.toContainText("[1m]");
  });

  test("la finestra c'è per OGNI modello, non solo per quelli a 1M", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "EFFORTUI-01" });
    // Il difetto segnalato: «il conteggio del contesto non c'è per tutti». Il
    // badge compariva solo sulle varianti col suffisso `[1m]`, quindi la sua
    // assenza non distingueva «questo modello non ha la finestra lunga» da «di
    // questo modello non lo diciamo»: due informazioni opposte, stesso schermo.
    await patchTopic(request, topicId, { provider: "claude-code", model: "claude-haiku-4-5" });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const picker = page.getByTestId("provider-model-picker");
    await picker.waitFor({ state: "visible", timeout: 10_000 });
    await expect(picker).toHaveAttribute("data-model", "claude-haiku-4-5", { timeout: 10_000 });
    const badge = picker.getByTestId("model-context-badge");
    await expect(badge).toHaveText("200K");
    await expect(badge).toHaveAttribute("data-context-known", "true");

    // E nella lista: ogni riga porta il suo numero, così la finestra si vede
    // NEL momento in cui si sceglie e non dopo, sul bottone.
    await picker.click();
    const popover = page.locator('[data-popover="provider-model-picker"]');
    await popover.waitFor({ state: "visible", timeout: 5_000 });
    const rows = popover.locator('[role="option"]');
    const total = await rows.count();
    // Un elenco VUOTO non è un difetto della finestra di contesto: è un
    // ambiente senza nessun provider pronto — i runner di CI, dove non c'è né il
    // binario `claude` né una chiave. Lì questo test misurerebbe l'assenza dei
    // modelli invece di ciò che gli interessa (che OGNI riga dichiari la sua
    // finestra), e infatti falliva con «il picker deve elencare almeno un
    // modello». Si salta dicendolo, come già fa provider-picker.spec.ts.
    //
    // Restano ASSERZIONI DURE tutte le righe qui sotto: appena un modello c'è,
    // deve dire il suo numero. Il salto copre «non ce n'è nessuno», non «non lo
    // dice».
    if (total === 0) {
      test.skip(true, "nessun provider pronto in questo ambiente — il picker non elenca modelli");
    }
    const rightEdges: number[] = [];
    for (let i = 0; i < total; i++) {
      const row = rows.nth(i);
      const model = await row.getAttribute("data-model");
      const win = row.getByTestId(`model-window-${model}`);
      await expect(win, `il modello ${model} deve dire la sua finestra`).toHaveText(
        /^≈?\d+(\.\d)?[KM]$/,
      );
      const box = await win.boundingBox();
      const rowBox = await row.boundingBox();
      if (!box || !rowBox) throw new Error(`riga ${model} non misurabile`);
      rightEdges.push(box.x + box.width);
      // Il numero sta DENTRO la riga: un id lungo deve cedere lui la larghezza
      // (truncate), non spingere la finestra fuori dal popover.
      expect(box.x + box.width, `la finestra di ${model} esce dalla riga`)
        .toBeLessThanOrEqual(rowBox.x + rowBox.width + 0.5);
    }
    // …e una COLONNA, non numeri sparsi: stesso bordo destro per tutti. È la
    // differenza fra una lista che si legge in verticale e tre etichette messe
    // dove capita dopo nomi di lunghezza diversa.
    const min = Math.min(...rightEdges);
    const max = Math.max(...rightEdges);
    expect(max - min, "le finestre devono formare una colonna allineata").toBeLessThanOrEqual(1);
  });
});
