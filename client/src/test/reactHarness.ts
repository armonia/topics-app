/**
 * Un runtime minimo di hook, per i test che devono guardare un RE-RENDER.
 *
 * PERCHE' ESISTE. In questo progetto jsdom/happy-dom non sono dipendenze (e' una
 * scelta dichiarata in mezza dozzina di test: `Shared/Select.test.tsx`,
 * `Board/ThreadRuns.test.tsx`, `lib/haptics.test.ts`), quindi l'unico montaggio
 * disponibile e' `renderToStaticMarkup`. Quello monta UNA volta e basta: non
 * esiste un secondo render, e senza secondo render non si possono osservare le
 * due cose che questo file serve a osservare — l'identita' di un context value
 * fra un render e il successivo, e un `useEffect` che si ri-arma perche' la sua
 * dipendenza cambia identita' a ogni giro. Sono guasti di RE-RENDER: per
 * definizione un renderer a colpo singolo non li vede.
 *
 * COME. React 19 risolve ogni hook attraverso un unico slot condiviso
 * (`React.__CLIENT_INTERNALS_….H`): e' cosi' che react-dom/server sostituisce il
 * dispatcher a react-dom/client. Qui si mette il nostro, e le `useState` /
 * `useEffect` che i componenti importano da 'react' finiscono qui dentro senza
 * bisogno di mockare il modulo (un mock di modulo, in questo repo, e' gia'
 * sopravvissuto al file che lo installava).
 *
 * COSA NON FA, ed e' deliberato: NESSUNA BAILOUT. Questo renderer richiama ogni
 * componente della sottochiave a ogni giro — non implementa `React.memo`, non
 * implementa il taglio dei consumatori di context. Non e' una mancanza da
 * colmare: un renderer scritto da chi scrive il test non puo' essere l'arbitro
 * di «React avrebbe saltato questo componente», o il test finirebbe per provare
 * la fedelta' del finto invece del codice vero (cfr. «asserzioni che non possono
 * fallire»). Quindi i test qui sopra NON contano le invocazioni: contano quante
 * IDENTITA' distinte di un valore un consumatore ha visto, che e' esattamente
 * l'input su cui React decide se svegliarlo, ed e' una misura del codice sotto
 * test e non di questo file.
 *
 * Un hook non implementato ALZA. Meglio un rosso che dice «manca useReducer» che
 * un verde ottenuto da un finto compiacente.
 */
import * as React from 'react';

const INTERNALS_KEY = '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE';

interface DispatcherSlot { H: unknown }

function dispatcherSlot(): DispatcherSlot {
  const slot = (React as unknown as Record<string, DispatcherSlot | undefined>)[INTERNALS_KEY];
  if (!slot || !('H' in slot)) {
    throw new Error(`reactHarness: React ${React.version} non espone ${INTERNALS_KEY}.H. Il runtime degli hook e' cambiato.`);
  }
  return slot;
}

interface Slot {
  value: unknown;
  deps?: readonly unknown[];
  cleanup?: (() => void) | void;
}

interface Fiber {
  slots: Slot[];
  children: Map<string, Fiber>;
}

function newFiber(): Fiber {
  return { slots: [], children: new Map() };
}

/** Le chiavi con cui un context si puo' presentare. React 19 rende il Context
 *  stesso renderizzabile (`<Ctx value>`), e i bundle piu' vecchi passano da
 *  `Ctx.Provider`: si indicizza su entrambe, cosi' il lookup non dipende da
 *  quale delle due forme ha scritto il componente. */
function contextKeys(x: unknown): unknown[] {
  const o = x as { Provider?: unknown; _context?: unknown } | null;
  const keys: unknown[] = [x];
  if (o && typeof o === 'object') {
    if (o.Provider && o.Provider !== x) keys.push(o.Provider);
    if (o._context && o._context !== x) keys.push(o._context);
  }
  return keys;
}

function depsChanged(prev: readonly unknown[] | undefined, next: readonly unknown[] | undefined): boolean {
  if (!prev || !next) return true;
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i++) if (!Object.is(prev[i], next[i])) return true;
  return false;
}

/** Il risultato di un giro: cosa e' stato disegnato e cosa e' passato dai provider. */
export interface RenderPass {
  /** I `value` di ogni `<X.Provider value={…}>` incontrato, in ordine di albero. */
  providerValues: unknown[];
  /** Tutto il testo dei nodi host, concatenato. */
  text: string;
}

export interface Harness {
  /** Un re-render dall'alto, come quando il genitore si ri-renderizza. */
  rerender(): void;
  /** L'esito dell'ultimo giro. */
  last(): RenderPass;
  /** Tutti i giri, dal mount in poi. */
  passes(): RenderPass[];
  unmount(): void;
}

/**
 * Monta `element` e restituisce il controller. Gli effetti girano subito dopo il
 * giro (come `useLayoutEffect`, non differiti): senza un loop di eventi vero
 * l'unico ordine sensato e' quello sincrono, e nessuno dei casi coperti qui
 * dipende dal rinvio.
 */
export function mount(element: React.ReactNode): Harness {
  const root = newFiber();
  const passList: RenderPass[] = [];
  let disposed = false;
  let rendering = false;
  let dirty = false;

  // Effetti da eseguire alla fine del giro corrente.
  let pending: Array<{ slot: Slot; create: () => (() => void) | void }> = [];

  let cursor: { fiber: Fiber; index: number } | null = null;

  /** Valori di context attivi lungo il ramo che si sta percorrendo. */
  const live = new Map<unknown, unknown>();

  const nextSlot = (): Slot => {
    if (!cursor) throw new Error('reactHarness: hook chiamato fuori da un render');
    const { fiber } = cursor;
    const i = cursor.index++;
    let slot = fiber.slots[i];
    if (!slot) {
      slot = { value: undefined };
      fiber.slots[i] = slot;
    }
    return slot;
  };

  const scheduleRender = (): void => {
    if (disposed) return;
    if (rendering) { dirty = true; return; }
    runUntilQuiet();
  };

  const useEffectImpl = (create: () => (() => void) | void, deps?: readonly unknown[]): void => {
    const slot = nextSlot();
    const first = slot.value !== 'armed';
    if (first || depsChanged(slot.deps, deps)) {
      slot.deps = deps;
      slot.value = 'armed';
      pending.push({ slot, create });
    }
  };

  const dispatcher = {
    useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void] {
      const slot = nextSlot();
      if (slot.value === undefined) {
        const first = typeof initial === 'function' ? (initial as () => S)() : initial;
        const set = (next: S | ((prev: S) => S)): void => {
          const pair = slot.value as [S, unknown];
          const value = typeof next === 'function' ? (next as (prev: S) => S)(pair[0]) : next;
          if (Object.is(value, pair[0])) return;
          slot.value = [value, set];
          scheduleRender();
        };
        slot.value = [first, set];
      }
      return slot.value as [S, (next: S | ((prev: S) => S)) => void];
    },
    useRef<T>(initial: T): { current: T } {
      const slot = nextSlot();
      if (slot.value === undefined) slot.value = { current: initial };
      return slot.value as { current: T };
    },
    useMemo<T>(factory: () => T, deps?: readonly unknown[]): T {
      const slot = nextSlot();
      if (slot.value === undefined || depsChanged(slot.deps, deps)) {
        slot.deps = deps;
        slot.value = { v: factory() };
      }
      return (slot.value as { v: T }).v;
    },
    useCallback<T>(fn: T, deps?: readonly unknown[]): T {
      return dispatcher.useMemo(() => fn, deps);
    },
    useEffect: useEffectImpl,
    useLayoutEffect: useEffectImpl,
    useInsertionEffect: useEffectImpl,
    useSyncExternalStore<T>(subscribe: (cb: () => void) => () => void, getSnapshot: () => T): T {
      const value = getSnapshot();
      useEffectImpl(() => subscribe(() => scheduleRender()), [subscribe]);
      return value;
    },
    useDebugValue(): void { /* no-op, come in produzione fuori dai devtools */ },
    useContext<T>(context: React.Context<T>): T {
      // I Provider vengono onorati (vedi `live`), ma NON producono bailout: chi
      // legge viene comunque richiamato a ogni giro. Il valore che riceve, pero',
      // e' quello vero — ed e' la sua IDENTITA' il dato che i test guardano.
      for (const key of contextKeys(context)) {
        if (live.has(key)) return live.get(key) as T;
      }
      return (context as unknown as { _currentValue: T })._currentValue;
    },
  };

  const unimplemented = new Proxy(dispatcher as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop];
      throw new Error(`reactHarness: hook non implementato (${String(prop)}). Implementalo qui invece di aggirarlo.`);
    },
  });

  const walk = (node: React.ReactNode, path: string, fiber: Fiber, pass: RenderPass): void => {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (typeof node === 'string' || typeof node === 'number') {
      pass.text += String(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child as React.ReactNode, `${path}.${i}`, fiber, pass));
      return;
    }
    if (!React.isValidElement(node)) return;
    const props = node.props as { children?: React.ReactNode; value?: unknown };
    const type = node.type;

    if (typeof type === 'function') {
      const name = (type as { displayName?: string; name?: string }).displayName ?? (type as { name?: string }).name ?? 'anonymous';
      const key = `${path}:${name}`;
      let child = fiber.children.get(key);
      if (!child) { child = newFiber(); fiber.children.set(key, child); }
      const prevCursor = cursor;
      cursor = { fiber: child, index: 0 };
      let out: React.ReactNode;
      try {
        out = (type as (p: unknown) => React.ReactNode)(props);
      } finally {
        cursor = prevCursor;
      }
      walk(out, `${key}/`, child, pass);
      return;
    }

    // Provider: il `value` e' il dato su cui React decide chi svegliare, quindi
    // si registra — ed e' quello che i consumatori del ramo leggeranno.
    if (typeof type === 'object' && type !== null && 'value' in props) {
      pass.providerValues.push(props.value);
      const keys = contextKeys(type);
      const saved = keys.map((k) => [k, live.has(k), live.get(k)] as const);
      for (const k of keys) live.set(k, props.value);
      walk(props.children, `${path}/c`, fiber, pass);
      for (const [k, had, prev] of saved) { if (had) live.set(k, prev); else live.delete(k); }
      return;
    }
    walk(props.children, `${path}/c`, fiber, pass);
  };

  const flushEffects = (): void => {
    const queue = pending;
    pending = [];
    for (const { slot, create } of queue) {
      if (typeof slot.cleanup === 'function') slot.cleanup();
      slot.cleanup = create();
    }
  };

  const renderOnce = (): void => {
    const pass: RenderPass = { providerValues: [], text: '' };
    rendering = true;
    const slot = dispatcherSlot();
    const prev = slot.H;
    slot.H = unimplemented;
    try {
      walk(element, '', root, pass);
    } finally {
      slot.H = prev;
      rendering = false;
    }
    passList.push(pass);
    flushEffects();
  };

  const runUntilQuiet = (): void => {
    let guard = 0;
    do {
      dirty = false;
      renderOnce();
      if (++guard > 50) throw new Error('reactHarness: render loop (50 giri): un setState in catena non converge');
    } while (dirty);
  };

  runUntilQuiet();

  const teardown = (fiber: Fiber): void => {
    for (const slot of fiber.slots) if (typeof slot.cleanup === 'function') slot.cleanup();
    for (const child of fiber.children.values()) teardown(child);
  };

  return {
    rerender: () => { if (!disposed) runUntilQuiet(); },
    last: () => passList[passList.length - 1]!,
    passes: () => passList,
    unmount: () => { if (disposed) return; disposed = true; teardown(root); },
  };
}
