/**
 * Le due superfici della chat, MISURATE.
 *
 * Sono cose che si vedono a occhio e che a occhio si giudicano male: «la bolla
 * si distingue?» e «la freccia è al posto giusto?» diventano numeri qui —
 * contrasto calcolato dal colore dipinto, e centro geometrico confrontato col
 * centro della colonna vera. Un test che guarda uno screenshot non le
 * prenderebbe; questi le prendono.
 */
import { test, expect, type Locator } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);
const BASE = E2E_BASE;

/** Luminanza relativa WCAG di un `rgb(...)`/`rgba(...)` come lo dipinge il browser. */
function luminanza(css: string): number {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`colore non riconosciuto: ${css}`);
  const [r, g, b] = m[1].split(",").slice(0, 3).map((v) => parseFloat(v) / 255);
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrasto(a: string, b: string): number {
  const la = luminanza(a), lb = luminanza(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

test.describe("Chat — superfici e affordance, misurate", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = `affordance-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    sessionKey = `topic:${topic.id.slice(0, 8)}`;
    // Il riempitivo PRIMA e il messaggio utente ULTIMO: la lista è
    // virtualizzata, quindi una bolla in cima a quaranta messaggi non è nel
    // DOM e il test cercherebbe un elemento che non c'è per un motivo che non
    // c'entra con quello che sta provando.
    for (let i = 0; i < 40; i++) {
      await request.post(`${BASE}/api/topics/${topicId}/system-message`, {
        data: { content: `Riempitivo ${i + 1}: ${"Lorem ipsum dolor sit amet. ".repeat(3)}` },
        ignoreHTTPSErrors: true,
      });
    }
    await seedMessage(request, { sessionKey, role: "user", content: "Un mio messaggio, con la sua bolla." });
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("la bolla dei propri messaggi è un grigio di sistema, non il blu del marchio", async ({ page }) => {
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    const bolla = page.locator('[data-testid="chat-message"][data-role="user"] .user-bubble').first();
    await expect(bolla).toBeVisible({ timeout: 15_000 });

    const misure = await bolla.evaluate((el) => {
      const cs = getComputedStyle(el);
      const root = getComputedStyle(document.documentElement);
      return {
        sfondo: cs.backgroundColor,
        testo: cs.color,
        pagina: root.getPropertyValue("--bg").trim(),
        primary: root.getPropertyValue("--primary").trim(),
      };
    });

    // Il testo dev'essere LEGGIBILE sulla bolla: AA su testo normale è 4,5:1.
    expect(contrasto(misure.testo, misure.sfondo)).toBeGreaterThan(4.5);

    // …e la bolla non dev'essere l'accento del marchio. Si confronta il colore
    // DIPINTO, non la classe: una classe può esserci e non vincere la cascata.
    const canale = (c: string) => c.match(/rgba?\(([^)]+)\)/)![1].split(",").slice(0, 3).map((v) => Math.round(parseFloat(v)));
    const [r, g, b] = canale(misure.sfondo);
    const scarto = Math.max(r, g, b) - Math.min(r, g, b);
    expect(scarto, `la bolla deve essere quasi-neutra, non una tinta (rgb ${r},${g},${b})`).toBeLessThan(20);
  });

  test("sotto l'ultima risposta resta sempre un varco, anche quando l'area input si muove", async ({ page }) => {
    // Misurato prima di metterlo: il varco era di SEI pixel — il testo stava
    // appiccicato al composer — e bastava che l'area input si RESTRINGESSE (il
    // banner di compattazione che si chiude, le righe del composer che si
    // riassorbono) perché diventassero ZERO, con in più sei pixel di scroll
    // residuo che nessuno chiudeva. Il varco è il margine che assorbe l'ultimo
    // assestamento: senza, se lo mangia dal TESTO.
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    const scroller = page.locator(`[aria-label="Messages for ${topicName}"] [data-virtuoso-scroller]`).first();
    await expect(scroller).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 8), { timeout: 15_000 }).toBe(true);

    const varco = async () => page.evaluate((nome) => {
      const righe = document.querySelectorAll(`[aria-label="Messages for ${nome}"] [data-item-index]`);
      const ultima = righe[righe.length - 1] as HTMLElement | undefined;
      const pane = document.querySelector(`[aria-label="Messages for ${nome}"]`)?.parentElement;
      const input = pane?.querySelector(":scope > .absolute.bottom-0") as HTMLElement | null;
      if (!ultima || !input) return null;
      return Math.round(input.getBoundingClientRect().top - ultima.getBoundingClientRect().bottom);
    }, topicName);

    const MINIMO = 16;
    expect(await varco(), "a riposo").toBeGreaterThanOrEqual(MINIMO);

    // L'area input CRESCE (è lo stesso percorso del banner di compattazione:
    // inputAreaHeight → Footer di Virtuoso).
    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.click();
    await textarea.fill("riga1\nriga2\nriga3\nriga4\nriga5\nriga6");
    await page.waitForTimeout(700);
    expect(await varco(), "mentre l'area input è cresciuta").toBeGreaterThanOrEqual(MINIMO);

    // …e si RESTRINGE: è il verso che prima lasciava il testo a contatto.
    await textarea.fill("");
    await page.waitForTimeout(700);
    expect(await varco(), "dopo che l'area input si è ristretta").toBeGreaterThanOrEqual(MINIMO);
    expect(
      await scroller.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight)),
      "e la vista resta al fondo vero",
    ).toBeLessThanOrEqual(8);
  });

  test("le strisce sopra il composer sono allineate FRA LORO e col composer", async ({ page, request }) => {
    // Si erano allineate in tre modi diversi: `mx-2` fisso (TodoStrip,
    // GoalBar), `mx-2/mx-3` a seconda della larghezza (gli avvisi e il
    // composer), più due raggi. Su desktop lo scarto è di quattro pixel:
    // abbastanza da vedersi come uno scalino, non abbastanza da sembrare
    // voluto. Qui si MISURA, invece di fidarsi della classe: due componenti
    // possono avere la stessa classe e stare in due contenitori diversi.
    //
    // Il campione era la striscia dei «messaggi da inviare», che NON esiste
    // più: la coda si vede una volta sola, come bolle dentro il trascritto
    // (`QueuedTurns`), quindi non è più una striscia e non ha più questo
    // allineamento da rispettare. La regola che questo test difende è però
    // della FAMIGLIA, non di quel membro: si misura la barra dell'obiettivo,
    // che prende la stessa `CHAT_STRIP_NEUTRAL` e sta nello stesso posto.
    await request.put(`${BASE}/api/topics/${topicId}/goal`, {
      data: { content: "Misurare l'allineamento delle strisce" },
    });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const input = page.getByRole("textbox", { name: /Message input/ });
    await input.waitFor({ state: "visible", timeout: 15_000 });

    const striscia = page.getByTestId("goal-bar");
    await expect(striscia, "la striscia dell'obiettivo deve montare").toBeVisible({ timeout: 15_000 });

    const bordi = await page.evaluate((nome) => {
      const pane = document.querySelector(`[aria-label="Messages for ${nome}"]`)?.parentElement;
      const form = pane?.querySelector("form");
      const strip = document.querySelector('[data-testid="goal-bar"]');
      if (!form || !strip) return null;
      const f = form.getBoundingClientRect(), s = strip.getBoundingClientRect();
      return { formL: Math.round(f.left), formR: Math.round(f.right), stripL: Math.round(s.left), stripR: Math.round(s.right) };
    }, topicName);

    expect(bordi, "composer e striscia devono essere entrambi a schermo").not.toBeNull();
    expect(Math.abs(bordi!.stripL - bordi!.formL), `bordo sinistro ${JSON.stringify(bordi)}`).toBeLessThanOrEqual(1);
    expect(Math.abs(bordi!.stripR - bordi!.formR), `bordo destro ${JSON.stringify(bordi)}`).toBeLessThanOrEqual(1);
  });

  test("la freccia «torna in fondo» è centrata sulla colonna, non appesa al bordo", async ({ page }) => {
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    const scroller = page.locator(`[aria-label="Messages for ${topicName}"] [data-virtuoso-scroller]`).first();
    await expect(scroller).toBeVisible({ timeout: 15_000 });

    // Si risale con una rotellina VERA: assegnare `scrollTop` è un movimento
    // che l'app classifica — correttamente — come proprio e non sgancia.
    await scroller.hover();
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, -2000);
      if (await scroller.evaluate((el) => el.scrollTop === 0)) break;
    }

    const freccia: Locator = page.locator('[data-testid="scroll-to-bottom"]');
    await expect(freccia).toBeVisible({ timeout: 8_000 });

    const geo = await page.evaluate((nome) => {
      const lista = document.querySelector(`[aria-label="Messages for ${nome}"] [data-testid="virtuoso-item-list"]`);
      const btn = document.querySelector('[data-testid="scroll-to-bottom"]');
      if (!lista || !btn) return null;
      const l = lista.getBoundingClientRect(), b = btn.getBoundingClientRect();
      return { centroColonna: l.left + l.width / 2, centroBottone: b.left + b.width / 2, larghezzaColonna: l.width };
    }, topicName);

    expect(geo, "colonna e bottone devono essere entrambi a schermo").not.toBeNull();
    // Otto pixel: sotto la soglia dell'occhio, sopra l'arrotondamento del layout.
    expect(
      Math.abs(geo!.centroBottone - geo!.centroColonna),
      `il bottone deve stare sul centro della colonna (colonna ${Math.round(geo!.larghezzaColonna)}px)`,
    ).toBeLessThan(8);

    // …e dev'essere TONDA, non ovale. `rounded-full` su un rettangolo dà un
    // ovale: la forma la decide il rapporto fra i lati. Senza conteggio i due
    // lati devono coincidere — un padding orizzontale fisso bastava a
    // sbilanciarla di sei pixel, e si vedeva.
    const forma = await freccia.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), badge: !!el.querySelector("span") };
    });
    if (!forma.badge) {
      expect(Math.abs(forma.w - forma.h), `senza conteggio dev'essere un cerchio (${forma.w}x${forma.h})`).toBeLessThanOrEqual(1);
    }
  });
});
