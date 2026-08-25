/**
 * Chi ha preso il fuoco, chiesto a un Chromium VERO.
 *
 * È la metà server della tastiera sul ramo video: lì il pane vede pixel, non ha
 * nessun mirror da interrogare, e l'unica risposta possibile a «che campo ho
 * toccato» la dà la pagina vera. Se `describeFocusedField` mente, il telefono
 * apre la tastiera sbagliata e nessuna prova lato client se ne accorge: la E2E
 * del pane gira contro un WS mockato, che risponde ciò che il test gli dice.
 *
 * Quindi qui si clicca davvero, con le coordinate, e si legge davvero
 * `document.activeElement` attraverso Playwright.
 *
 * Corsia PESANTE come `browser-dom-cobrowse.test.ts`, e per la stessa ragione:
 * lancia un Chromium, e sotto carico un timeout che scatta direbbe «il fuoco è
 * rotto» quando il fatto è «la macchina era occupata». Si lancia con
 * `bun run test:heavy` (o `TOPICS_HEAVY_TESTS=1`).
  * @covers FOCFIELD-01
 */
import { describe, it, expect } from 'bun:test';
import { createBrowserService } from './browser-service';
import { keyboardProfileForField } from '../shared/browser-keyboard-field';

const HEAVY = process.env.TOPICS_HEAVY_TESTS === '1';
const describeHeavy = HEAVY ? describe : describe.skip;

/**
 * Un modulo con posizioni note: il click arriva in coordinate, quindi i campi
 * stanno dove dico io. `about:blank` costruito da dentro, zero rete.
 */
const BUILD_FORM = `
  document.title = 'FUOCO';
  document.body.style.margin = '0';
  document.body.innerHTML =
    '<form>' +
    '<input id="e" type="email" enterkeyhint="send" style="position:absolute;left:0;top:0;width:300px;height:60px">' +
    '<input id="n" type="text" inputmode="numeric" style="position:absolute;left:0;top:80px;width:300px;height:60px">' +
    '<input id="b" type="button" value="vai" style="position:absolute;left:0;top:160px;width:300px;height:60px">' +
    '<input id="r" type="text" readonly style="position:absolute;left:0;top:240px;width:300px;height:60px">' +
    '</form>';
`;

describeHeavy('browser-service: il campo a fuoco dopo un click (real browser)', () => {
  it('riporta il campo che il click ha messo a fuoco, e tace su ciò che non si scrive', async () => {
    const svc = await createBrowserService({ broadcastToBrowserWs: () => {} });
    const id = `focus-field-${Date.now()}`;
    try {
      await svc.createContext(id);
      await svc.evaluate(id, BUILD_FORM);

      // ── Un campo email dentro un form ───────────────────────────────────────
      await svc.dispatchInput(id, 'click', { x: 150, y: 30 });
      const email = await svc.describeFocusedField(id);
      expect(email).not.toBeNull();
      expect(email?.tag).toBe('input');
      expect(email?.type).toBe('email');
      expect(email?.enterKeyHint).toBe('send');
      expect(email?.inForm).toBe(true);
      // E la tastiera che ne esce è quella che il pane monterà sul telefono.
      expect(keyboardProfileForField(email)?.type).toBe('email');

      // ── `inputmode` dichiarato: il campo OTP ────────────────────────────────
      await svc.dispatchInput(id, 'click', { x: 150, y: 110 });
      const otp = await svc.describeFocusedField(id);
      expect(otp?.inputMode).toBe('numeric');
      expect(keyboardProfileForField(otp)?.inputMode).toBe('numeric');

      // ── Un bottone non è un campo ───────────────────────────────────────────
      // Cliccarlo sposta il fuoco sul bottone: la risposta deve essere «niente
      // di scrivibile», che è ciò che fa RIENTRARE la tastiera sul telefono.
      await svc.dispatchInput(id, 'click', { x: 150, y: 190 });
      const button = await svc.describeFocusedField(id);
      expect(keyboardProfileForField(button)).toBeNull();

      // ── Sola lettura: iOS la tastiera non la apre ───────────────────────────
      await svc.dispatchInput(id, 'click', { x: 150, y: 270 });
      const readonly = await svc.describeFocusedField(id);
      expect(readonly?.readOnly).toBe(true);
      expect(keyboardProfileForField(readonly)).toBeNull();
    } finally {
      await svc.close();
    }
  }, 45000);

  it('senza contesto non inventa niente (e non fa nascere un Chromium)', async () => {
    const svc = await createBrowserService({ broadcastToBrowserWs: () => {} });
    try {
      expect(await svc.describeFocusedField('contesto-che-non-esiste')).toBeNull();
      expect(svc.isLaunched()).toBe(false);
    } finally {
      await svc.close();
    }
  }, 20000);
});
