/**
 * Sonda di diagnosi: CHI sporca il layout mentre l'app è ferma.
 *
 * PERCHÉ ESISTE (2026-07-28). Con la finestra VISIBILE l'app costa ~106% di CPU
 * (per core), con la finestra in background 34%: la differenza è tutta rendering
 * continuo. Il profilo nativo (`sample` sul WebContent) dice *cosa* costa —
 * `RenderView::layout` → `simplifiedLayout` → `layoutOutOfFlowBox` → 14 livelli
 * di flex rilayoutati ogni frame — ma NON dice *chi* lo invalida: i frame JS
 * sono JIT e `sample` non li sa nominare. E l'ambiente E2E non riproduce niente
 * (0.3 layout/s), perché lì non ci sono terminali, sessioni vive né pane
 * browser.
 *
 * Quindi la sonda va dove sta il problema: dentro l'app vera. Registra per una
 * finestra breve
 *  - le MUTAZIONI del DOM per elemento (chi cambia a ogni frame),
 *  - le letture che forzano un layout SINCRONO (`getBoundingClientRect`,
 *    `offset*`/`client*`/`scroll*`) per chiamante,
 *  - le notifiche di ResizeObserver per bersaglio,
 *  - i rAF per chiamante,
 *  - le animazioni CSS ancora in corso (il caso "nessuna mutazione ma il layout
 *    si sporca lo stesso").
 * e RIMANDA il verdetto al server, così è leggibile da fuori senza devtools.
 *
 * SICUREZZA. Non parte mai da sola: legge `dev-layout-probe` dallo ui-state e
 * gira solo se `armed === true`. Si DISARMA prima di cominciare, quindi una
 * ricarica accidentale non la rifà partire. Tutte le patch sono ripristinate a
 * fine finestra. Con il flag assente — cioè sempre, in condizioni normali — il
 * costo è una GET e nient'altro.
 *
 * Uso: `curl -sk -X PUT https://localhost:3333/api/ui-state/dev-layout-probe \
 *        -H 'Content-Type: application/json' -d '{"armed":true}'`, ricaricare la
 * finestra, poi leggere `/api/ui-state/dev-layout-probe-result`.
 */

import { readProbeFlag, writeProbeState } from './devProbeProtocol';

const FLAG_KEY = 'dev-layout-probe';
const RESULT_KEY = 'dev-layout-probe-result';
/** Finestra di registrazione: lunga abbastanza da vedere una pompa, corta abbastanza da non pesare. */
const WINDOW_MS = 15_000;
/** Quanti frame di stack tenere per identificare il chiamante. */
const STACK_FRAMES = 4;
/** Quante voci per classifica finiscono nel verdetto. */
const TOP_N = 12;

type Counter = Map<string, number>;

function bump(c: Counter, key: string) {
  c.set(key, (c.get(key) ?? 0) + 1);
}

function top(c: Counter, n = TOP_N): [string, number][] {
  return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

/** Chi ha chiamato: si saltano i frame della sonda stessa. */
function caller(): string {
  const raw = (new Error().stack ?? '').split('\n');
  return raw.slice(2, 2 + STACK_FRAMES).map((l) => l.trim()).join(' ← ');
}

/**
 * Etichetta un nodo in modo LEGGIBILE da fuori: si risale fino a trovare un
 * marcatore stabile (`data-testid`, `data-pane-id`, `data-pane-kind`), perché è
 * l'unica cosa che permette di dire "è la pane X" invece di "è un div".
 */
function label(node: Node | null): string {
  let el: Element | null =
    node instanceof Element ? node : (node?.parentElement ?? null);
  const parts: string[] = [];
  for (let i = 0; el && i < 5; i++, el = el.parentElement) {
    const testid = el.getAttribute('data-testid');
    const paneId = el.getAttribute('data-pane-id') ?? el.getAttribute('data-pane-kind');
    if (testid) parts.push(`@${testid}`);
    else if (paneId) parts.push(`#${paneId}`);
    else if (parts.length === 0) {
      const cls = String(el.className || '').split(/\s+/).slice(0, 3).join('.');
      parts.push(cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase());
    }
    if (parts.length >= 2) break;
  }
  return parts.join(' in ') || '(detached)';
}

/**
 * Avvia la sonda se armata. Ritorna una funzione di stop (idempotente) che
 * ripristina ogni patch: va chiamata allo smontaggio anche se la sonda non è
 * partita.
 */
export function initDevLayoutProbe(): () => void {
  let stop = () => {};
  void readProbeFlag(FLAG_KEY).then((armed) => {
    if (!armed) return;
    void writeProbeState(FLAG_KEY, { armed: false }); // one-shot: mai due giri di fila
    stop = run();
  });
  return () => stop();
}

function run(): () => void {
  const mutations: Counter = new Map();
  const syncReads: Counter = new Map();
  const resizes: Counter = new Map();
  const rafs: Counter = new Map();
  /**
   * Chi scrive le classi, con che token e da dove. Un cambio di classe sulla
   * radice di un sottoalbero grande invalida lo stile di TUTTO quel sottoalbero,
   * quindi il conteggio da solo non basta: serve il nome del token e il
   * chiamante.
   *
   * Perché intercettando le API invece che dal MutationObserver: i record
   * arrivano in batch, e confrontare `oldValue` col valore CORRENTE fa sembrare
   * "identico" ogni toggle rapido (remove+add danno due record, entrambi già
   * riallineati al valore finale). Il primo giro di questa sonda ci è cascato e
   * ha riportato 556 "riscritture identiche" che identiche non erano.
   */
  const classFlips: Counter = new Map();
  let mutationTotal = 0;
  let rafTotal = 0;
  const t0 = performance.now();

  // ── 1. mutazioni del DOM ────────────────────────────────────────────────
  const mo = new MutationObserver((records) => {
    mutationTotal += records.length;
    for (const r of records) {
      const what =
        r.type === 'attributes' ? `attr:${r.attributeName}` : r.type === 'characterData' ? 'text' : 'children';
      bump(mutations, `${what} → ${label(r.target)}`);

    }
  });
  mo.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeOldValue: true,
    characterData: true,
  });

  // ── 2. letture che forzano un layout sincrono ───────────────────────────
  // Sono queste a trasformare "layout sporco" in "layout RICALCOLATO ORA", ed è
  // il motivo per cui un singolo lettore in un rAF può costare un quarto del
  // main thread. Si patcha il prototipo e si conta per CHIAMANTE.
  const restores: (() => void)[] = [];
  const geomProps = [
    'offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft', 'offsetParent',
    'clientWidth', 'clientHeight', 'clientTop', 'clientLeft',
    'scrollWidth', 'scrollHeight',
  ] as const;
  for (const prop of geomProps) {
    const proto = prop.startsWith('offset') ? HTMLElement.prototype : Element.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc?.get) continue;
    const original = desc.get;
    Object.defineProperty(proto, prop, {
      ...desc,
      get(this: Element) {
        bump(syncReads, `${prop} ← ${caller()}`);
        return original.call(this);
      },
    });
    restores.push(() => Object.defineProperty(proto, prop, desc));
  }
  const gbcr = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    bump(syncReads, `getBoundingClientRect ← ${caller()}`);
    return gbcr.call(this);
  };
  restores.push(() => {
    Element.prototype.getBoundingClientRect = gbcr;
  });

  // ── 2b. scritture di `class` ────────────────────────────────────────────
  const tokenProto = DOMTokenList.prototype as unknown as Record<string, unknown>;
  for (const method of ['add', 'remove', 'toggle', 'replace'] as const) {
    const orig = tokenProto[method] as ((...args: unknown[]) => unknown) | undefined;
    if (typeof orig !== 'function') continue;
    tokenProto[method] = function (this: DOMTokenList, ...args: unknown[]) {
      bump(classFlips, `${method}(${args.map(String).join(',')}) ← ${caller()}`);
      return orig.apply(this, args);
    };
    restores.push(() => { tokenProto[method] = orig; });
  }
  const classNameDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'className');
  if (classNameDesc?.set) {
    const origSet = classNameDesc.set;
    Object.defineProperty(Element.prototype, 'className', {
      ...classNameDesc,
      set(this: Element, v: string) {
        const same = String(this.className) === String(v);
        bump(classFlips, `className=${same ? 'IDENTICA ' : ''}"${String(v).slice(0, 40)}" ← ${caller()}`);
        origSet.call(this, v);
      },
    });
    restores.push(() => Object.defineProperty(Element.prototype, 'className', classNameDesc));
  }

  // ── 3. ResizeObserver ───────────────────────────────────────────────────
  const OrigRO = window.ResizeObserver;
  window.ResizeObserver = class extends OrigRO {
    constructor(cb: ResizeObserverCallback) {
      super((entries, obs) => {
        for (const e of entries) bump(resizes, label(e.target));
        cb(entries, obs);
      });
    }
  } as typeof ResizeObserver;
  restores.push(() => {
    window.ResizeObserver = OrigRO;
  });

  // ── 4. rAF ──────────────────────────────────────────────────────────────
  const origRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafTotal++;
    bump(rafs, caller());
    return origRaf(cb);
  }) as typeof requestAnimationFrame;
  restores.push(() => {
    window.requestAnimationFrame = origRaf;
  });

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    mo.disconnect();
    for (const r of restores.reverse()) r();
    const seconds = (performance.now() - t0) / 1000;
    const animations = document
      .getAnimations()
      .filter((a) => a.playState === 'running')
      .map((a) => {
        const eff = a.effect as KeyframeEffect | null;
        const t = eff && 'target' in eff ? eff.target : null;
        return `${(a as unknown as { animationName?: string }).animationName ?? '(transition)'} su ${label(t)}`;
      });
    void writeProbeState(RESULT_KEY, {
      seconds: Math.round(seconds * 10) / 10,
      perSecond: {
        mutations: Math.round(mutationTotal / seconds),
        raf: Math.round(rafTotal / seconds),
      },
      topMutations: top(mutations),
      topClassFlips: top(classFlips),
      topSyncReads: top(syncReads),
      topResizes: top(resizes),
      topRaf: top(rafs),
      runningAnimations: [...new Set(animations)].slice(0, TOP_N),
    });
  };
  const timer = setTimeout(finish, WINDOW_MS);
  return finish;
}
