/**
 * Who decides where the transcript is anchored: sending re-anchors and pins,
 * a starting turn never drags back someone reading history, and the guard
 * tells a user scroll apart from a re-measure jitter.
 *
 * @covers CHAT-01
 */
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
    const staccato = at({ anchored: false });
    const d = reduceScroll(staccato, { type: 'stream-start' }, 1_000);
    expect(d.state.anchored).toBe(false);
    expect(d.pin).toBe(false);
    // …e la guardia non si arma: non c'è nessuno scroll forzato da coprire.
    expect(d.state.guardUntil).toBe(0);
  });

  it('inviare vince comunque sulla vista sganciata (è l\'intento di seguire)', () => {
    const staccato = at({ anchored: false });
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
      at(),
      { type: 'user-scrolled-up', streaming: false, distanceFromBottom: 900 },
      1_000,
    );
    expect(d.state.anchored).toBe(false);
  });

  it('fuori dallo stream, un colpetto di rotellina vicino al fondo NON sgancia', () => {
    // Sotto la tolleranza sei ancora «in fondo»: sganciare qui farebbe comparire
    // il bottone «torna in fondo» per due pixel.
    const d = reduceScroll(
      at(),
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

  it('dentro la finestra NON sgancia nemmeno uno scarto grande: è roba nostra', () => {
    // Prima questo scarto veniva preso per l'utente, ed era il difetto: premi
    // «Riprova» (o invii, o apri la chat), noi riancoriamo e pinniamo, poi
    // arriva la riga nuova, il banner sparisce, il composer cambia altezza e la
    // lista si rimisura — per un attimo Virtuoso annuncia centinaia di pixel di
    // distanza. Sganciare lì significava vietare ogni pin per il resto del
    // turno: la risposta scorreva via sotto una vista ferma.
    const d = reduceScroll(guarded, {
      type: 'left-bottom', streaming: false, distanceFromBottom: 900,
    }, T0 + 100);
    expect(d.state.anchored).toBe(true);
  });

  it('…e il controllo resta all\'utente, che ha il suo evento e scavalca la guardia', () => {
    // La contropartita di sopra: se in quella stessa finestra l'utente tira su
    // la rotellina, quello è un GESTO — l'app non ne produce — e sgancia subito.
    const d = reduceScroll(guarded, {
      type: 'user-scrolled-up', streaming: false, source: 'gesture', distanceFromBottom: 900,
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
  it('un salto in fondo che non abbiamo fatto noi NON riancora', () => {
    // La lista si ri-ancora da sé dopo una rimisura: in traccia `top: 0` e un
    // istante dopo il fondo, senza nessun pin di mezzo. Perdonarlo incollava la
    // vista per il resto della sessione a chi stava leggendo indietro.
    const staccato = at({ anchored: false });
    const d = reduceScroll(staccato, { type: 'reached-bottom', teleported: true }, T0);
    expect(d.state.anchored).toBe(false);
    expect(d.state).toBe(staccato);
  });


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

describe('la guardia protegge lo scroll che abbiamo forzato NOI', () => {
  it('un calo di scrollTop dentro la guardia è il nostro assestamento, non l\'utente', () => {
    // Il bottone «torna in fondo» porta giù via `scrollToIndex('LAST')`, poi
    // Virtuoso rimisura e abbassa `scrollTop` di qualche decina di pixel.
    // Contarlo come utente sganciava il pin appena messo: la vista tornava in
    // fondo e se ne staccava da sola un istante dopo.
    const afterButton = reduceScroll(at({ anchored: false }), { type: 'scroll-to-bottom' }, T0);
    expect(afterButton.state.guardUntil).toBe(T0 + SCROLL_GUARD_MS);
    const assestamento = reduceScroll(
      afterButton.state,
      { type: 'user-scrolled-up', streaming: false, distanceFromBottom: 400 },
      T0 + 100,
    );
    expect(assestamento.state.anchored).toBe(true);
    expect(assestamento.state).toBe(afterButton.state);
  });

  it('durante lo stream la guardia NON copre: lì il pin alza e basta, un calo è l\'utente', () => {
    // Il pin dello stream scrive `scrollTop = scrollHeight`: non abbassa mai.
    // Se la guardia coprisse anche quello, chi prova a leggere mentre l'agente
    // scrive resterebbe inchiodato al fondo per mezzo secondo a ogni turno.
    const dopoInvio = reduceScroll(at({ anchored: true }), { type: 'user-sent' }, T0);
    const d = reduceScroll(dopoInvio.state, { type: 'user-scrolled-up', streaming: true }, T0 + 200);
    expect(d.state.anchored).toBe(false);
  });

  it('scaduta la guardia, l\'utente torna a comandare anche fuori dallo stream', () => {
    const afterButton = reduceScroll(at({ anchored: false }), { type: 'scroll-to-bottom' }, T0);
    const d = reduceScroll(
      afterButton.state,
      { type: 'user-scrolled-up', streaming: false, distanceFromBottom: 400 },
      T0 + SCROLL_GUARD_MS + 1,
    );
    expect(d.state.anchored).toBe(false);
  });

  /**
   * Le due sorgenti di «l'utente ha scrollato su» non hanno la stessa
   * affidabilità, e prima erano indistinguibili: la guardia le sopprimeva
   * entrambe. Effetto: per 600ms dopo ogni nostro scroll forzato l'utente non
   * poteva sganciare — cioè proprio nell'istante in cui uno reagisce a un salto
   * che non voleva.
   */
  it('dentro la guardia: il GESTO sgancia, il calo di scrollTop no', () => {
    const afterButton = reduceScroll(at({ anchored: false }), { type: 'scroll-to-bottom' }, T0);
    const gesto = reduceScroll(
      afterButton.state,
      { type: 'user-scrolled-up', streaming: false, source: 'gesture', distanceFromBottom: 400 },
      T0 + 100,
    );
    expect(gesto.state.anchored, 'la rotellina è un gesto: l\'app non ne produce').toBe(false);

    const misura = reduceScroll(
      afterButton.state,
      { type: 'user-scrolled-up', streaming: false, source: 'delta', distanceFromBottom: 400 },
      T0 + 100,
    );
    expect(misura.state.anchored, 'il calo può essere la rimisura di Virtuoso').toBe(true);
  });

  it('senza sorgente dichiarata si assume la lettura prudente (delta)', () => {
    const afterButton = reduceScroll(at({ anchored: false }), { type: 'scroll-to-bottom' }, T0);
    const d = reduceScroll(
      afterButton.state,
      { type: 'user-scrolled-up', streaming: false, distanceFromBottom: 400 },
      T0 + 100,
    );
    expect(d.state.anchored).toBe(true);
  });

  it('anche il gesto rispetta la geometria: vicino al fondo non sgancia', () => {
    // Un colpetto di rotellina mentre sei già in fondo non è «voglio leggere
    // indietro»: se sganciasse, comparirebbe la freccia «torna in fondo» su una
    // vista che è in fondo.
    const afterButton = reduceScroll(at({ anchored: false }), { type: 'scroll-to-bottom' }, T0);
    const d = reduceScroll(
      afterButton.state,
      { type: 'user-scrolled-up', streaming: false, source: 'gesture', distanceFromBottom: 10 },
      T0 + 100,
    );
    expect(d.state.anchored).toBe(true);
  });
});

describe('identità dello stato — un evento che non cambia niente non ridisegna', () => {
  // Questo stato vive in un `useReducer`: un oggetto NUOVO a ogni evento è un
  // render nuovo a ogni evento, e gli eventi di scroll arrivano uno per frame.
  // Una lista virtualizzata che rimisura decine di volte al secondo ti sposta la
  // vista sotto gli occhi — il sintomo era esattamente «lo scroll fa cose sue».
  it('sganciare due volte restituisce lo STESSO oggetto', () => {
    const primo = reduceScroll(at({ anchored: true }), { type: 'user-scrolled-up', streaming: true }, T0);
    const secondo = reduceScroll(primo.state, { type: 'user-scrolled-up', streaming: true }, T0 + 16);
    expect(secondo.state).toBe(primo.state);
  });

  it('«sono in fondo» ripetuto non crea stati nuovi', () => {
    const ancorato = at({ anchored: true });
    expect(reduceScroll(ancorato, { type: 'reached-bottom' }, T0).state).toBe(ancorato);
  });

  it('un left-bottom che non sgancia lascia lo stato dov\'era', () => {
    const staccato = at({ anchored: false });
    const d = reduceScroll(staccato, { type: 'left-bottom', streaming: false, distanceFromBottom: 900 }, T0 + 10_000);
    expect(d.state).toBe(staccato);
  });

  it('ma un cambio VERO produce uno stato nuovo', () => {
    const ancorato = at({ anchored: true });
    const d = reduceScroll(ancorato, { type: 'user-scrolled-up', streaming: true }, T0);
    expect(d.state).not.toBe(ancorato);
    expect(d.state.anchored).toBe(false);
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

/**
 * LA PRESA DELL'UTENTE — la fascia sotto i 150px, dove il difetto viveva.
 *
 * Sotto la tolleranza l'autorità resta `anchored` di proposito (il bottone
 * «torna in fondo» non deve comparire per un colpo di rotellina), e finché
 * nessuno pinnava fuori dallo stream quella convinzione era innocua. Coi pin
 * sulla rimisura non lo è più: scorrere all'insù monta righe nuove, l'altezza
 * totale cambia, e il pin che ne segue riportava giù chi stava scorrendo.
 */
describe('presa dell’utente (userHeld)', () => {
  it('un GESTO a 40px dal fondo non sgancia (niente bottone) ma vieta il pin', () => {
    const d = reduceScroll(
      at(),
      { type: 'user-scrolled-up', streaming: false, source: 'gesture', distanceFromBottom: 40 },
      T0,
    );
    expect(d.state.anchored).toBe(true); // il bottone resta nascosto, come prima
    expect(d.state.userHeld).toBe(true);
    expect(shouldPin(d.state, { jumpPending: false })).toBe(false);
  });

  it('un calo AMBIGUO dentro la guardia non alza la presa (è un nostro riassestamento)', () => {
    const s = run(at({ guardUntil: T0 + SCROLL_GUARD_MS }), [
      { type: 'user-scrolled-up', streaming: false, source: 'delta', distanceFromBottom: 40 },
    ]);
    expect(s.userHeld).toBe(false);
    expect(shouldPin(s, { jumpPending: false })).toBe(true);
  });

  it('la presa regge a una raffica di rimisure: è il caso live che rompeva', () => {
    let s = reduceScroll(
      at(),
      { type: 'user-scrolled-up', streaming: false, source: 'gesture', distanceFromBottom: 60 },
      T0,
    ).state;
    for (let i = 0; i < 10; i++) {
      // Ogni riga montata scorrendo cambia l'altezza totale: Virtuoso lo
      // annuncia entro la tolleranza, e prima da qui ripartiva il pin.
      const d = reduceScroll(s, { type: 'left-bottom', streaming: false, distanceFromBottom: 60 }, T0 + i);
      s = d.state;
      expect(d.pin).toBe(false);
      expect(shouldPin(s, { jumpPending: false })).toBe(false);
    }
  });

  it('torna al fondo VERO → la presa si scioglie e l’aggancio riprende', () => {
    const s = run(at(), [
      { type: 'user-scrolled-up', streaming: false, source: 'gesture', distanceFromBottom: 60 },
      { type: 'reached-bottom', distanceFromBottom: 0 },
    ]);
    expect(s.userHeld).toBe(false);
    expect(shouldPin(s, { jumpPending: false })).toBe(true);
  });

  it('«in fondo» secondo Virtuoso (100px) NON la scioglie: lì si sta ancora leggendo', () => {
    const s = run(at(), [
      { type: 'user-scrolled-up', streaming: false, source: 'gesture', distanceFromBottom: 60 },
      { type: 'reached-bottom', distanceFromBottom: 100 },
    ]);
    expect(s.userHeld).toBe(true);
    expect(shouldPin(s, { jumpPending: false })).toBe(false);
  });

  it('un ritorno al fondo TELEPORTATO non scioglie niente', () => {
    const s = run(at(), [
      { type: 'user-scrolled-up', streaming: false, source: 'gesture', distanceFromBottom: 60 },
      { type: 'reached-bottom', teleported: true, distanceFromBottom: 0 },
    ]);
    expect(s.userHeld).toBe(true);
  });

  it('un turno che COMINCIA non gliela toglie: non è detto che l’abbia avviato lui', () => {
    const s = run(at(), [
      { type: 'user-scrolled-up', streaming: false, source: 'gesture', distanceFromBottom: 60 },
      { type: 'stream-start' },
    ]);
    expect(s.userHeld).toBe(true);
    expect(shouldPin(s, { jumpPending: false })).toBe(false);
  });

  it('invio, «torna in fondo» e cambio topic sono intenti espliciti: la sciolgono', () => {
    for (const e of [
      { type: 'user-sent' },
      { type: 'scroll-to-bottom' },
      { type: 'topic-switch' },
    ] as ScrollEvent[]) {
      const s = run(at(), [
        { type: 'user-scrolled-up', streaming: false, source: 'gesture', distanceFromBottom: 60 },
        e,
      ]);
      expect(s.userHeld).toBe(false);
    }
  });

  it('durante lo stream il gesto sgancia E tiene la presa', () => {
    const d = reduceScroll(
      at(),
      { type: 'user-scrolled-up', streaming: true, source: 'gesture', distanceFromBottom: 10 },
      T0,
    );
    expect(d.state.anchored).toBe(false);
    expect(d.state.userHeld).toBe(true);
  });

  it('stato invariato ⇒ stesso oggetto (il riduttore vive in un render)', () => {
    const held = reduceScroll(
      at(),
      { type: 'user-scrolled-up', streaming: false, source: 'gesture', distanceFromBottom: 60 },
      T0,
    ).state;
    const again = reduceScroll(
      held,
      { type: 'user-scrolled-up', streaming: false, source: 'gesture', distanceFromBottom: 60 },
      T0,
    ).state;
    expect(again).toBe(held);
  });
});
