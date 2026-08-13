/**
 * La macchina a stati dell'avviso sulla memoria delle webview.
 *
 * Il contratto che vale la pena inchiodare, tutto falsificabile senza React:
 *   - si accende solo oltre 4096 MB, e sotto non dice niente;
 *   - si spegne solo sotto 3584 MB, quindi un valore che balla intorno ai 4 GB
 *     non fa lampeggiare il banner (è l'isteresi, ed è la ragione per cui le
 *     due soglie sono due);
 *   - chiuso dall'utente, torna solo dopo +2048 MB rispetto al valore che si
 *     leggeva alla chiusura;
 *   - scendendo sotto lo spegnimento il rifiuto si dimentica, perché la
 *     situazione su cui era stato deciso non c'è più;
 *   - senza misura (web, o lettura parziale su Windows e Linux) lo stato non si
 *     muove di un bit.
 */
import { describe, test, expect } from 'bun:test';
import {
  WEBVIEW_MEMORY_WARNING_INITIAL,
  WEBVIEW_WARN_OFF_MB,
  WEBVIEW_WARN_ON_MB,
  WEBVIEW_WARN_REARM_DELTA_MB,
  dismissWebviewMemoryWarning,
  formatWebviewMemoryGB,
  nextWebviewMemoryWarning,
  type WebviewMemoryWarningState,
} from './webviewMemoryWarning';

/** Una sequenza di campioni, come la vedrebbe il poll. */
const campiona = (mb: Array<number | null>, da = WEBVIEW_MEMORY_WARNING_INITIAL): WebviewMemoryWarningState =>
  mb.reduce<WebviewMemoryWarningState>((stato, v) => nextWebviewMemoryWarning(stato, v), da);

describe('accensione', () => {
  test('sotto la soglia non si accende', () => {
    expect(campiona([0, 1024, 3000, WEBVIEW_WARN_ON_MB - 1]).visible).toBe(false);
  });

  test('alla soglia esatta si accende', () => {
    expect(campiona([WEBVIEW_WARN_ON_MB]).visible).toBe(true);
  });

  test('la scena misurata (9,7 GB di webview) accende', () => {
    expect(campiona([9932]).visible).toBe(true);
  });
});

describe('isteresi', () => {
  test('acceso, resta acceso finché non scende sotto lo spegnimento', () => {
    // Il footprint respira: comprimere e ripaginare muove il numero di
    // centinaia di MB a scena ferma. Nessuno di questi campioni è un calo vero.
    const stato = campiona([5000, 4000, 4200, 3900, WEBVIEW_WARN_OFF_MB]);
    expect(stato.visible).toBe(true);
  });

  test('si spegne solo sotto la soglia di spegnimento', () => {
    expect(campiona([5000, WEBVIEW_WARN_OFF_MB - 1]).visible).toBe(false);
  });

  test('spento fra le due soglie, ci resta: non basta risalire sopra lo spegnimento', () => {
    // Il caso che una soglia sola sbaglierebbe al contrario: 3600 MB non ha mai
    // acceso niente, e non deve accendere adesso solo perché sta sopra a 3584.
    expect(campiona([3600, 4000]).visible).toBe(false);
  });
});

describe('rifiuto e ri-armo', () => {
  test('chiuso, sparisce e ricorda il valore letto alla chiusura', () => {
    const acceso = campiona([5000]);
    const chiuso = dismissWebviewMemoryWarning(acceso, 5000);
    expect(chiuso).toEqual({ visible: false, dismissedAtMB: 5000 });
  });

  test('non torna mentre la memoria cresce di poco', () => {
    const chiuso = dismissWebviewMemoryWarning(campiona([5000]), 5000);
    const dopo = campiona([5200, 6000, 5000 + WEBVIEW_WARN_REARM_DELTA_MB - 1], chiuso);
    expect(dopo.visible).toBe(false);
  });

  test('torna quando la crescita è sostanziale', () => {
    const chiuso = dismissWebviewMemoryWarning(campiona([5000]), 5000);
    const dopo = campiona([5000 + WEBVIEW_WARN_REARM_DELTA_MB], chiuso);
    expect(dopo.visible).toBe(true);
    // Il rifiuto è consumato: la prossima chiusura riparte dal suo valore, non
    // si somma alla precedente.
    expect(dopo.dismissedAtMB).toBe(null);
  });

  test('due rifiuti di fila alzano il riferimento una volta per volta', () => {
    let stato = dismissWebviewMemoryWarning(campiona([5000]), 5000);
    stato = campiona([7048], stato);
    expect(stato.visible).toBe(true);
    stato = dismissWebviewMemoryWarning(stato, 7048);
    expect(stato.dismissedAtMB).toBe(7048);
    expect(campiona([9000], stato).visible).toBe(false);
    expect(campiona([9096], stato).visible).toBe(true);
  });

  test('scendendo sotto lo spegnimento il rifiuto si dimentica', () => {
    const chiuso = dismissWebviewMemoryWarning(campiona([5000]), 5000);
    const sceso = campiona([1000], chiuso);
    expect(sceso).toEqual(WEBVIEW_MEMORY_WARNING_INITIAL);
    // Ripartendo, vale di nuovo la soglia normale e non 5000 + 2048.
    expect(campiona([WEBVIEW_WARN_ON_MB], sceso).visible).toBe(true);
  });

  test('chiudere un avviso già spento non registra niente', () => {
    const spento = WEBVIEW_MEMORY_WARNING_INITIAL;
    expect(dismissWebviewMemoryWarning(spento, 9000)).toBe(spento);
  });
});

describe('nessuna misura', () => {
  test('null non muove lo stato e non accende niente (web)', () => {
    expect(campiona([null, null, null])).toBe(WEBVIEW_MEMORY_WARNING_INITIAL);
  });

  test('null non spegne un avviso acceso (lettura mancata, non calo)', () => {
    const acceso = campiona([5000]);
    expect(nextWebviewMemoryWarning(acceso, null)).toBe(acceso);
  });

  test('un valore non finito viene ignorato come una misura assente', () => {
    expect(campiona([Number.NaN, Number.POSITIVE_INFINITY]).visible).toBe(false);
  });
});

describe('identità', () => {
  test('un campione che non cambia niente ritorna lo stesso oggetto', () => {
    // Serve al chiamante: `setState` con lo stesso riferimento non ridisegna, e
    // questo poll gira per sempre in sottofondo.
    const spento = WEBVIEW_MEMORY_WARNING_INITIAL;
    expect(nextWebviewMemoryWarning(spento, 1000)).toBe(spento);
    const acceso = campiona([5000]);
    expect(nextWebviewMemoryWarning(acceso, 6000)).toBe(acceso);
  });
});

describe('formatWebviewMemoryGB', () => {
  test('gigabyte con una cifra e la virgola', () => {
    expect(formatWebviewMemoryGB(9932)).toBe('9,7');
    expect(formatWebviewMemoryGB(4096)).toBe('4,0');
    expect(formatWebviewMemoryGB(5120)).toBe('5,0');
  });
});
