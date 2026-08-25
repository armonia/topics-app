/**
 * @covers HAPTIC-01
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { haptic, __resetHaptics } from './haptics';

type StubNavigator = { vibrate?: unknown };
const g = globalThis as unknown as { navigator: StubNavigator | undefined };
const realNavigator = g.navigator;

afterEach(() => { g.navigator = realNavigator; });

describe('haptic() — l’unica porta per la micro-vibrazione', () => {
  test('dove la Vibration API c’è, la pulsazione parte davvero', () => {
    const calls: unknown[] = [];
    g.navigator = { vibrate: (p: unknown) => { calls.push(p); return true; } };

    expect(haptic('medium')).toBe(true);
    expect(calls).toEqual([20]);
  });

  test('i tre livelli sono tre durate diverse, e il default è il più leggero', () => {
    const calls: unknown[] = [];
    g.navigator = { vibrate: (p: unknown) => { calls.push(p); return true; } };

    haptic('light');
    haptic('medium');
    haptic('heavy');
    haptic();

    // Se un giorno i tre livelli collassassero sullo stesso numero, «medium» e
    // «heavy» sarebbero decorazione: la differenza è il contratto.
    expect(calls).toEqual([10, 20, 30, 10]);
  });

  test('su iPhone la Vibration API non esiste: `false`, e nessuna eccezione', () => {
    // Il caso REALE del dispositivo di casa. caniuse: «Safari on iOS 3.2 – 26.5:
    // Not supported». Qui si pretende che il no-op sia SILENZIOSO — vedi il test
    // successivo per il perché conta.
    g.navigator = {};

    expect(haptic('medium')).toBe(false);
  });

  test('una `vibrate` dichiarata ma non funzione non deve LANCIARE', () => {
    // `'vibrate' in navigator` sarebbe vero qui, e la chiamata tirerebbe un
    // TypeError. Non è pignoleria: l’unico chiamante è il timer di
    // `useLongPress`, che fa `haptic('medium')` sulla riga PRIMA di aprire il
    // menu contestuale — un throw qui e il «tieni premuto» smette di aprire
    // qualsiasi menu su tutto il touch.
    g.navigator = { vibrate: undefined };
    expect(() => haptic('medium')).not.toThrow();
    expect(haptic('medium')).toBe(false);

    g.navigator = { vibrate: null };
    expect(() => haptic('medium')).not.toThrow();
    expect(haptic('medium')).toBe(false);
  });

  test('se la piattaforma LANCIA, l’eccezione non risale al gesto', () => {
    // Stessa posta in gioco del test sopra, altro modo di perderla: una
    // `vibrate` che c’è, è una funzione, e tira lo stesso (permessi, iframe
    // senza user activation, WebView di terze parti).
    g.navigator = { vibrate: () => { throw new Error('NotAllowedError'); } };

    expect(() => haptic('medium')).not.toThrow();
    expect(haptic('medium')).toBe(false);
  });

  test('senza `navigator` (SSR / worker) non esplode', () => {
    g.navigator = undefined;

    expect(() => haptic()).not.toThrow();
    expect(haptic()).toBe(false);
  });
});

describe('haptic — il ripiego iOS (switch nativo)', () => {
  // Su iPhone la Vibration API non esiste: `haptic()` deve tentare lo switch,
  // che su iOS 17.4–26.4 fa suonare il Taptic Engine. Si prova ciò che il web
  // PUÒ osservare — che il click parta e che l'elemento sia inerte — non che il
  // motore suoni, che nessuna API riporta.
  //
  // Il DOM è STUBATO, non montato (happy-dom non è una dipendenza del progetto e
  // gli altri test client fanno lo stesso): qui serve solo sapere quale elemento
  // viene creato, con quali attributi, e quante volte lo si clicca.
  interface FakeEl {
    tag: string; type: string; tabIndex: number; checked: boolean; name: string;
    id: string; htmlFor: string;
    isConnected: boolean; style: { cssText: string };
    attrs: Record<string, string>;
    setAttribute(k: string, v: string): void;
    getAttribute(k: string): string | null;
    click(): void;
  }
  let creati: FakeEl[] = [];
  let clicks = 0;
  const realDoc = (globalThis as { document?: unknown }).document;
  const realNav = (globalThis as { navigator?: unknown }).navigator;

  const stubDom = (ua: string) => {
    creati = []; clicks = 0;
    const mk = (tag: string): FakeEl => {
      const el: FakeEl = {
        tag, type: '', tabIndex: 0, checked: false, name: '', id: '', htmlFor: '',
        isConnected: false, style: { cssText: '' }, attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
        click() { clicks++; },
      };
      creati.push(el); return el;
    };
    Object.defineProperty(globalThis, 'document', {
      value: { createElement: (t: string) => mk(t), body: { appendChild: (e: FakeEl) => { e.isConnected = true; } } },
      configurable: true, writable: true,
    });
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: ua }, configurable: true, writable: true,
    });
  };
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15';

  afterEach(() => {
    if (realDoc === undefined) delete (globalThis as { document?: unknown }).document;
    else Object.defineProperty(globalThis, 'document', { value: realDoc, configurable: true, writable: true });
    if (realNav === undefined) delete (globalThis as { navigator?: unknown }).navigator;
    else Object.defineProperty(globalThis, 'navigator', { value: realNav, configurable: true, writable: true });
    __resetHaptics();
  });

  test('su iPhone senza Vibration API il click parte', () => {
    stubDom(IPHONE);
    expect(haptic('medium')).toBe(true);
    expect(clicks, 'il tick è UN click, e va sulla label').toBe(1);
    const cliccato = creati.find(e => e.tag === 'label');
    expect(cliccato, 'deve esistere una label legata allo switch').toBeTruthy();
    expect(cliccato!.htmlFor, 'la label deve puntare allo switch').toBe(
      creati.find(e => e.tag === 'input')!.id,
    );
  });

  test("l'elemento è inerte: fuori dall'albero a11y, non focalizzabile, non toccabile", () => {
    stubDom(IPHONE);
    haptic();
    // Due elementi: lo switch e la label che lo attiva.
    expect(creati.length).toBe(2);
    const el = creati.find(e => e.tag === 'input')!;
    expect(el.type).toBe('checkbox');
    // È l'attributo `switch` — non la checkbox — ad avere il tick di sistema.
    expect(el.getAttribute('switch')).toBe('');
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.tabIndex).toBe(-1);
    expect(el.style.cssText).toContain('pointer-events:none');
    // `display:none`/`visibility:hidden` spegnerebbero il tick: deve essere
    // renderizzato e invisibile, non tolto dal rendering.
    expect(el.style.cssText).not.toContain('display:none');
    expect(el.style.cssText).not.toContain('visibility:hidden');
    expect(el.name, 'senza name non finisce in nessun invio di form').toBe('');
  });

  test('se ne crea UNO solo, per quante volte lo si chiami', () => {
    stubDom(IPHONE);
    for (let i = 0; i < 5; i++) haptic();
    expect(creati.length, 'switch + label, creati una volta sola').toBe(2);
    expect(clicks).toBe(5);
  });

  test('lo stato non resta sporco: dopo il tick lo switch è spento', () => {
    stubDom(IPHONE);
    haptic();
    expect(creati.find(e => e.tag === 'input')!.checked).toBe(false);
  });

  test('fuori da iOS non nasce nessun elemento', () => {
    stubDom('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    expect(haptic()).toBe(false);
    expect(creati.length).toBe(0);
  });
});
