import { test, expect } from "./fixtures/browser-v2.fixture";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, waitForTopicVisible, resetPaneStore } from "./helpers/api-fixtures";
import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * IL BROWSER, COL DITO.
 *
 * Segnalazione del 12/08, dal telefono: «su un sito, quando clicco un campo, mi
 * esce una tastiera a caso e mi va la pagina scalata».
 *
 * Non era casuale: era SEMPRE la stessa. Nel co-browse DOM la pagina remota è un
 * mirror non scrivibile, e il campo che riceve davvero il fuoco è un campo di
 * cattura NOSTRO, nascosto — quindi la tastiera che iOS apre è quella di QUEL
 * campo, che era una <textarea> nuda: email, numero e password davano tutti la
 * tastiera di testo. Ed era una casella da 1×1px col font di default (~13px),
 * cioè sotto la soglia dei 16 che fa ingrandire la pagina al focus.
 *
 * Questa spec gira nel progetto `chromium-touch-wide` (`hasTouch` + `isMobile`,
 * viewport larga): senza il dito vero il ramo touch non si tocca, e un tap col
 * mouse verificherebbe l'esatto contrario di ciò che qui si afferma. La
 * larghezza da telefono NON serve — e non si può usare: a 390px il pane browser
 * sta dietro la navigazione mobile e il tocco atterra sulla colonna dei topic.
 *
 * Quello che questo motore PUÒ provare: che al tocco il campo di cattura si
 * veste come il campo remoto (tipo, inputmode, tasto invio), che su un bottone
 * non prende il fuoco affatto, e che il suo font non scende sotto i 16px.
 * Quello che NON può: lo zoom automatico di iOS, che è una euristica di Safari
 * su iPhone e in Chromium non esiste. Per quello vale l'invariante dei 16px —
 * la soglia documentata che lo fa scattare — più la misura della scala qui
 * sotto, che tiene il contratto onesto su ogni motore che la implementa.
 */
const RRWEB_FIELDS = JSON.parse(
  readFileSync(resolvePath(__dirname, "fixtures/rrweb-fields.json"), "utf-8"),
) as unknown[];

/** Dimensioni della pagina registrata nel fixture (evento Meta). */
const SRC_W = 900;

/** Centro di ogni campo, in px della pagina remota (vedi rrweb-fields.json). */
const FIELDS = {
  text: { x: 170, y: 50 },
  email: { x: 170, y: 130 },
  number: { x: 170, y: 210 },
  password: { x: 170, y: 290 },
  otp: { x: 170, y: 370 },
  button: { x: 170, y: 450 },
  readonly: { x: 170, y: 530 },
} as const;

interface CaptureState {
  type: string;
  inputMode: string;
  enterKeyHint: string;
  fontSize: number;
  focused: boolean;
}

async function mountBrowserPane(
  page: import("@playwright/test").Page,
  topicId: string,
  url = "https://esempio.test/modulo",
): Promise<void> {
  await page.evaluate(
    ({ tid, u }) => {
      window.dispatchEvent(
        new CustomEvent("browser:open-and-navigate", { detail: { topicId: tid, url: u } }),
      );
    },
    { tid: topicId, u: url },
  );
  await expect(page.locator('[data-testid="browser-url-input"]').first()).toBeVisible({ timeout: 10000 });
}

test.describe("Browser da telefono — la tastiera segue il campo", () => {
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
  });

  test("ogni campo apre la SUA tastiera, un bottone non ne apre nessuna, e la scala non si muove [MOBILE-KBD]", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 10 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true,
      url: "https://esempio.test/modulo",
      title: "Modulo",
      hasScreenshot: true,
    });
    browserProcessPageV2.mockDomCoBrowse(RRWEB_FIELDS);

    const topic = await createTopic(request, `E2E-MOBKBD-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPane(page, topic.id);

      const dom = page.locator('[data-testid="browser-dom-cobrowse"]').first();
      await expect(dom).toBeVisible({ timeout: 8000 });
      // Il mirror ha ricostruito il modulo: da qui in poi i campi ESISTONO, e
      // `elementFromPoint` sul mirror può rispondere chi c'è sotto il dito.
      await expect(dom.frameLocator("iframe").locator("#f-email")).toHaveCount(1, { timeout: 8000 });

      const overlay = page.locator('[data-testid="browser-dom-input-overlay"]').first();
      const kbd = page.locator('[data-testid="browser-dom-kbd"]').first();

      const box = await overlay.boundingBox();
      expect(box, "l'overlay di cattura deve avere un rettangolo").not.toBeNull();
      // L'overlay è il mirror scalato per stare nella pane: da px della pagina
      // remota a px sullo schermo si passa da qui — la stessa scala che il
      // componente usa per rilanciare i click.
      const scale = box!.width / SRC_W;
      expect(scale).toBeGreaterThan(0);

      const scaleBefore = await page.evaluate(() => window.visualViewport?.scale ?? 1);

      const tapField = async (f: { x: number; y: number }): Promise<CaptureState> => {
        await page.touchscreen.tap(box!.x + f.x * scale, box!.y + f.y * scale);
        return kbd.evaluate((el) => {
          const input = el as HTMLInputElement;
          return {
            type: input.type,
            inputMode: input.inputMode,
            enterKeyHint: input.enterKeyHint,
            fontSize: parseFloat(getComputedStyle(input).fontSize),
            focused: document.activeElement === input,
          };
        });
      };

      // ── Il cuore del difetto: quattro campi, quattro tastiere ────────────────
      const text = await tapField(FIELDS.text);
      expect(text.focused, "toccare un campo di testo deve far salire la tastiera").toBe(true);
      expect(text.type).toBe("text");
      // In un form l'invio manda: è quello che il tasto deve dire.
      expect(text.enterKeyHint).toBe("go");

      const email = await tapField(FIELDS.email);
      expect(email.focused).toBe(true);
      expect(email.type, "un campo email deve dare la tastiera email, non quella di testo").toBe("email");

      const number = await tapField(FIELDS.number);
      expect(number.focused).toBe(true);
      expect(number.type, "un campo numero deve dare il tastierino numerico").toBe("number");

      const password = await tapField(FIELDS.password);
      expect(password.focused).toBe(true);
      expect(password.type, "una password resta una password").toBe("password");

      // `inputmode` è la dichiarazione fatta apposta per la tastiera e vince sul
      // `type`: un campo OTP è testo, ma la tastiera dev'essere numerica.
      const otp = await tapField(FIELDS.otp);
      expect(otp.focused).toBe(true);
      expect(otp.inputMode).toBe("numeric");
      expect(otp.enterKeyHint).toBe("send");

      // ── E dove NON deve salire niente ────────────────────────────────────────
      // Prima si toccava un bottone e si apriva comunque una tastiera, perché il
      // fuoco veniva preso a ogni tocco senza guardare cosa ci fosse sotto.
      const button = await tapField(FIELDS.button);
      expect(button.focused, "un bottone non è un campo: nessuna tastiera").toBe(false);

      const ro = await tapField(FIELDS.readonly);
      expect(ro.focused, "un campo in sola lettura non apre la tastiera nemmeno su iOS").toBe(false);

      // ── La pagina non si scala ───────────────────────────────────────────────
      // 16px è la soglia: sotto, iOS ingrandisce la pagina per «adattare» il
      // campo a fuoco — e quello era 1×1px, quindi l'ingrandimento era il massimo.
      for (const s of [text, email, number, password, otp]) {
        expect(s.fontSize, "il campo di cattura non deve mai scendere sotto i 16px").toBeGreaterThanOrEqual(16);
      }
      const scaleAfter = await page.evaluate(() => window.visualViewport?.scale ?? 1);
      expect(scaleAfter, "la scala del viewport non cambia toccando i campi").toBe(scaleBefore);

      // ── E si scrive davvero ──────────────────────────────────────────────────
      // Vestire la cattura non deve averle tolto il mestiere: torna su un campo e
      // ciò che si batte arriva alla pagina vera come `input`/`type`.
      await tapField(FIELDS.email);
      browserProcessPageV2.drainInputMessages();
      await page.keyboard.type("ciao@esempio.it");
      let typed = 0;
      await expect
        .poll(() => {
          typed += browserProcessPageV2
            .drainInputMessages()
            .filter((m) => {
              const t = m as { type?: string; action?: string };
              return t?.type === "input" && t?.action === "type";
            }).length;
          return typed;
        }, { timeout: 5000 })
        .toBeGreaterThan(0);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
