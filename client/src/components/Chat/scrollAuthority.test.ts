import { describe, it, expect } from 'bun:test';
import {
  AT_BOTTOM_TOLERANCE_PX,
  RESTORE_DETACH_PX,
  SCROLL_GUARD_MS,
  USER_SCROLL_UP_PX,
  initialScrollAuthority,
  isUserScrollUp,
  reduceScroll,
  shouldPin,
  type ScrollAuthorityState,
  type ScrollEvent,
} from './scrollAuthority';

const T0 = 1_000_000;

const at = (over: Partial<ScrollAuthorityState> = {}): ScrollAuthorityState => ({
  ...initialScrollAuthority,
  ...over,
});

/** Manda una sequenza di eventi allo stesso istante e ritorna lo stato finale. */
const run = (state: ScrollAuthorityState, events: ScrollEvent[], now = T0) =>
  events.reduce((s, e) => reduceScroll(s, e, now).state, state);

describe('stato iniziale', () => {
  it('parte ancorato al fondo, senza guardia in forza', () => {
    expect(initialScrollAuthority.anchored).toBe(true);
    expect(shouldPin(initialScrollAuthority, { jumpPending: false })).toBe(true);
  });
});

describe('riancoraggi espliciti', () => {
  it('inviare un messaggio riancora e pinna, anche da vista sganciata', () => {
    const d = reduceScroll(at({ anchored: false }), { type: 'user-sent' }, T0);
    expect(d.state.anchored).toBe(true);
    expect(d.pin).toBe(true);
  });

  it('il bottone "torna in fondo" fa la stessa cosa', () => {
    const d = reduceScroll(at({ anchored: false }), { type: 'scroll-to-bottom' }, T0);
    expect(d.state.anchored).toBe(true);
    expect(d.pin).toBe(true);
  });

  it('un turno che comincia NON trascina in fondo chi era andato a leggere indietro', () => {
    // Un turno non è sempre dell'utente: lo avviano la board, un agente,
    // un'altra finestra. Se la vista era sganciata deve restarci — «ho appena
    // inviato» ha il suo evento, `user-sent`, che riancora comunque.
    const staccato = { anchored: false, guardUntil: 0 };
    const d = reduceScroll(staccato, { type: 'stream-start' }, 1_000);
    expect(d.state.anchored).toBe(false);
    expect(d.pin).toBe(false);
    // …e la guardia non si arma: non c'è nessuno scroll forzato da coprire.
    expect(d.state.guardUntil).toBe(0);
  });

  it('inviare vince comunque sulla vista sganciata (è l\'intento di seguire)', () => {
    const staccato = { anchored: false, guardUntil: 0 };
    const d = reduceScroll(staccato, { type: 'user-sent' }, 1_000);
    expect(d.state.anchored).toBe(true);
    expect(d.pin).toBe(true);
  });

  it('il cambio topic riancora ma NON pinna — lo fa chi aspetta il caricamento', () => {
    // `stream-start` NON è più in questa lista: da vista sganciata ri-afferma e
    // basta, perché un turno che comincia non è per forza dell'utente. Il caso
    // sta nel test qui sopra.
    for (const type of ['topic-switch'] as const) {
      const d = reduceScroll(at({ anchored: false }), { type }, T0);
      expect(d.state.anchored).toBe(true);
      expect(d.pin).toBe(false);
    }
  });

  it('ogni riancoraggio arma la guardia', () => {
    for (const type of ['topic-switch', 'stream-start', 'user-sent', 'scroll-to-bottom'] as const) {
      expect(reduceScroll(at(), { type }, T0).state.guardUntil).toBe(T0 + SCROLL_GUARD_MS);
    }
  });
});

describe('lo scroll dell\'utente', () => {
  it('durante lo stream sgancia SUBITO — senza aspettare Virtuoso', () => {
    // Il bug: il pin gira a ogni chunk gated solo sullo stato "sono in fondo",
    // e ributtava la vista giù prima che atBottomStateChange(false) arrivasse a
    // sganciare. L'utente restava inchiodato al fondo ("non riesco a scrollare
    // su durante lo stream").
    const d = reduceScroll(at(), { type: 'user-scrolled-up', streaming: true }, T0);
    expect(d.state.anchored).toBe(false);
    expect(shouldPin(d.state, { jumpPending: false })).toBe(false);
  });

  it('fuori dallo stream, una tirata VERA sgancia subito: non si aspetta Virtuoso', () => {
    // Virtuoso tace finché non supera la sua soglia, e in quel silenzio la vista
    // restava «ancorata» mentre l'utente stava già leggendo indietro: il
    // messaggio dopo gliela ributtava in fondo. Con la distanza misurata lo
    // sgancio è immediato.
    const d = reduceScroll(
      { anchored: true, guardUntil: 0 },
      { type: 'user-scrolled-up', streaming: false, distanceFromBottom: 900 },
      1_000,
    );
    expect(d.state.anchored).toBe(false);
  });

  it('fuori dallo stream, un colpetto di rotellina vicino al fondo NON sgancia', () => {
    // Sotto la tolleranza sei ancora «in fondo»: sganciare qui farebbe comparire
    // il bottone «torna in fondo» per due pixel.
    const d = reduceScroll(
      { anchored: true, guardUntil: 0 },
      { type: 'user-scrolled-up', streaming: false, distanceFromBottom: 40 },
      1_000,
    );
    expect(d.state.anchored).toBe(true);
  });

  it('fuori dallo stream NON sgancia da solo: decide la geometria', () => {
    // Nessuno sta combattendo con l'utente: un colpo di rotellina da pochi pixel
    // non deve far comparire il bottone né fermare l'aggancio di un messaggio
    // in arrivo. Sgancia `left-bottom` con la sua tolleranza di 150px.
    const d = reduceScroll(at(), { type: 'user-scrolled-up', streaming: false }, T0);
    expect(d.state.anchored).toBe(true);
  });

  it('isUserScrollUp distingue il dito dal jitter di rimisura', () => {
    expect(isUserScrollUp(500, 500 - USER_SCROLL_UP_PX - 1)).toBe(true);
    expect(isUserScrollUp(500, 500 - USER_SCROLL_UP_PX)).toBe(false);
    expect(isUserScrollUp(500, 480)).toBe(false);
    // Il pin dell'app ALZA scrollTop: una salita non è mai l'utente che risale.
    expect(isUserScrollUp(500, 900)).toBe(false);
  });
});

describe('left-bottom durante lo stream', () => {
  it('non sgancia mai: un tool block che cresce sotto il pin NON è l\'utente', () => {
    // "perde l'aggancio da solo": latchare lo sgancio su questo evento
    // congelava la vista a metà stream.
    const d = reduceScroll(at(), { type: 'left-bottom', streaming: true, distanceFromBottom: 4000 }, T0);
    expect(d.state.anchored).toBe(true);
    expect(d.pin).toBe(true);
  });

  it('ri-asserisce il pin solo se siamo ancora ancorati', () => {
    // Se l'utente ha già afferrato lo scroll, ri-pinnare sarebbe rimetterlo in
    // fondo a forza a ogni chunk.
    const d = reduceScroll(at({ anchored: false }), { type: 'left-bottom', streaming: true, distanceFromBottom: 900 }, T0);
    expect(d.pin).toBe(false);
    expect(d.state.anchored).toBe(false);
  });
});

describe('left-bottom fuori dallo stream — la guardia', () => {
  const guarded = at({ guardUntil: T0 + SCROLL_GUARD_MS });

  it('dentro la finestra, uno scarto piccolo è il nostro stesso scroll forzato', () => {
    const d = reduceScroll(guarded, {
      type: 'left-bottom', streaming: false, distanceFromBottom: AT_BOTTOM_TOLERANCE_PX - 1,
    }, T0 + 100);
    expect(d.state.anchored).toBe(true);
  });

  it('dentro la finestra, uno scarto GRANDE è comunque l\'utente', () => {
    const d = reduceScroll(guarded, {
      type: 'left-bottom', streaming: false, distanceFromBottom: AT_BOTTOM_TOLERANCE_PX,
    }, T0 + 100);
    expect(d.state.anchored).toBe(false);
  });

  it('scaduta la finestra, anche uno scarto piccolo sgancia', () => {
    const d = reduceScroll(guarded, {
      type: 'left-bottom', streaming: false, distanceFromBottom: 10,
    }, T0 + SCROLL_GUARD_MS);
    expect(d.state.anchored).toBe(false);
  });
});

describe('ritorno in fondo', () => {
  it('perdona lo sgancio: la crescita successiva riaggancia', () => {
    const d = reduceScroll(at({ anchored: false }), { type: 'reached-bottom' }, T0);
    expect(d.state.anchored).toBe(true);
    expect(d.pin).toBe(false);
  });
});

describe('offset ripristinato (undo di una pane)', () => {
  it('un ripristino lontano dal fondo sgancia', () => {
    const d = reduceScroll(at(), { type: 'offset-restored', distanceFromBottom: RESTORE_DETACH_PX + 1 }, T0);
    expect(d.state.anchored).toBe(false);
  });

  it('un ripristino che di fatto è il fondo resta ancorato', () => {
    const d = reduceScroll(at(), { type: 'offset-restored', distanceFromBottom: RESTORE_DETACH_PX }, T0);
    expect(d.state.anchored).toBe(true);
  });

  it('la banda del ripristino è più STRETTA della tolleranza live', () => {
    // Un ripristino deliberato non va arrotondato al fondo.
    expect(RESTORE_DETACH_PX).toBeLessThan(AT_BOTTOM_TOLERANCE_PX);
  });
});

describe('shouldPin — l\'unica domanda', () => {
  it('un salto da palette pendente veta OGNI ancoraggio al fondo', () => {
    // Il bug: il salto posizionava la lista e, 100ms dopo, uno dei quattro
    // meccanismi di bottom-anchor la ributtava giù smontando la riga target.
    expect(shouldPin(at({ anchored: true }), { jumpPending: true })).toBe(false);
  });

  it('senza salto, risponde `anchored` e basta', () => {
    expect(shouldPin(at({ anchored: true }), { jumpPending: false })).toBe(true);
    expect(shouldPin(at({ anchored: false }), { jumpPending: false })).toBe(false);
  });
});

describe('sequenze vere', () => {
  it('stream → utente scrolla su → fine stream: resta sganciato', () => {
    const s = run(at(), [
      { type: 'stream-start' },
      { type: 'user-scrolled-up', streaming: true },
      { type: 'left-bottom', streaming: true, distanceFromBottom: 800 },
    ]);
    expect(s.anchored).toBe(false);
    // Un messaggio che arriva dopo non deve strappargli via la vista.
    expect(shouldPin(s, { jumpPending: false })).toBe(false);
  });

  it('…e inviare un nuovo messaggio lo riporta a seguire', () => {
    const s = run(at(), [
      { type: 'stream-start' },
      { type: 'user-scrolled-up', streaming: true },
      { type: 'user-sent' },
    ]);
    expect(s.anchored).toBe(true);
  });

  it('cambio topic azzera qualunque sgancio precedente', () => {
    const s = run(at(), [
      { type: 'user-scrolled-up', streaming: true },
      { type: 'topic-switch' },
    ]);
    expect(s.anchored).toBe(true);
  });

  it('un tool block gigante a metà stream non sgancia mai, per quanti ne arrivino', () => {
    let s = at();
    for (let i = 0; i < 20; i++) {
      const d = reduceScroll(s, { type: 'left-bottom', streaming: true, distanceFromBottom: 300 * i }, T0 + i);
      s = d.state;
      expect(d.pin).toBe(true);
    }
    expect(s.anchored).toBe(true);
  });
});
