/**
 * La soglia fra SELEZIONARE e GUARDARE (FASE 2, AC a).
 *
 * Perché esiste. `sidebarRowCard` applica FOCUS WINS: la riga che stai guardando
 * torna neutra e non pulsa. La regola è giusta — non vuoi che ti lampeggi in
 * faccia ciò che stai leggendo — ma "stai guardando" voleva dire "è selezionata",
 * senza tempo. Un clic di passaggio per cercare un'altra tab spegneva il fill di
 * una chat mai letta, e nello stesso istante `clearUnreadFor` (agganciato al
 * frame 'focus' uscente in useWebSocket) ne azzerava l'unread. Le due cose
 * insieme sono il sintomo: "la tab non resta blu finché non la visualizzo".
 *
 * Qui si fissa la politica, che è pura e quindi provabile senza store né WS:
 * quanto deve durare lo sguardo. When a seen stops counting is the server's
 * now (the epoch, `server/attention/store.ts`), and the local valve of the
 * project row is `attentionFillFor`.
 *
 * @covers TAB-BADGE-02, TAB-BADGE-07
 */
import { describe, test, expect } from 'bun:test';
import { SEEN_DWELL_MS, attentionFillFor, isSeen } from './signals';

describe('isSeen — la soglia', () => {
  test('non davanti (null) non è mai visto, per quanto tempo passi', () => {
    expect(isSeen(null, 0)).toBe(false);
    expect(isSeen(null, 10_000_000)).toBe(false);
  });

  test('davanti da meno della soglia: NON visto — è il clic di passaggio', () => {
    const t0 = 1_000_000;
    expect(isSeen(t0, t0)).toBe(false);
    expect(isSeen(t0, t0 + 200)).toBe(false); // clic e via
    expect(isSeen(t0, t0 + SEEN_DWELL_MS - 1)).toBe(false);
  });

  test('davanti da almeno la soglia: visto', () => {
    const t0 = 1_000_000;
    expect(isSeen(t0, t0 + SEEN_DWELL_MS)).toBe(true);
    expect(isSeen(t0, t0 + SEEN_DWELL_MS + 5_000)).toBe(true);
  });

  test('la soglia è iniettabile, così un test non dipende dalla costante', () => {
    expect(isSeen(0, 300, 500)).toBe(false);
    expect(isSeen(0, 500, 500)).toBe(true);
  });

  test('la soglia sta fra il clic di passaggio e il ritardo percepibile', () => {
    // Non un numero magico: sotto ~600ms si torna al comportamento di prima,
    // sopra ~2s il fill sembra non cadere mai.
    expect(SEEN_DWELL_MS).toBeGreaterThanOrEqual(600);
    expect(SEEN_DWELL_MS).toBeLessThanOrEqual(2000);
  });
});

describe('attentionFillFor — FOCUS WINS in un posto solo', () => {
  test('nessun tier ⇒ nessun fill, visto o no', () => {
    expect(attentionFillFor(null, false)).toBe(null);
    expect(attentionFillFor(null, true)).toBe(null);
    expect(attentionFillFor(undefined, false)).toBe(null);
  });

  test('tier presente e NON visto ⇒ il fill si mostra', () => {
    expect(attentionFillFor('done', false)).toBe('done');
    expect(attentionFillFor('needs-you', false)).toBe('needs-you');
    expect(attentionFillFor('error', false)).toBe('error');
  });

  test('tier presente e visto ⇒ niente fill: non pulsa ciò che stai guardando', () => {
    expect(attentionFillFor('done', true)).toBe(null);
  });

  test("l'ambra visto resta: un permesso in attesa si spegne con la risposta, non con lo sguardo", () => {
    // The group card does not gate it on seen: the tab and the row say the same.
    expect(attentionFillFor('needs-you', true)).toBe('needs-you');
  });

  test('il tier non viene mai riscritto: needs-you resta needs-you, done resta done', () => {
    // Regressione: il tier 'needs-you' (ambra, "rispondi ora") è l'unico segnale
    // act-now dell'app. Un helper che lo declassasse a 'done' lo cancellerebbe.
    expect(attentionFillFor('needs-you', false)).not.toBe('done');
  });
});
