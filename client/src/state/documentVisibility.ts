type VisibilityListener = () => void;

const listeners = new Set<VisibilityListener>();
let listening = false;

/** Read the document's visibility without depending on a React render. */
export function isDocumentVisible(): boolean {
  return typeof document === 'undefined' || !document.hidden;
}

function notifyVisibilityChange(): void {
  for (const listener of [...listeners]) listener();
}

/** Share one DOM listener among every consumer that needs a visibility edge. */
export function subscribeDocumentVisibility(listener: VisibilityListener): () => void {
  listeners.add(listener);
  if (!listening && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', notifyVisibilityChange);
    listening = true;
  }

  return () => {
    listeners.delete(listener);
    if (listening && listeners.size === 0 && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', notifyVisibilityChange);
      listening = false;
    }
  };
}

export interface VisibleIntervalEnv {
  isVisible(): boolean;
  subscribe(listener: VisibilityListener): () => void;
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(timer: unknown): void;
}

export const DEFAULT_VISIBLE_INTERVAL_ENV: VisibleIntervalEnv = {
  isVisible: isDocumentVisible,
  subscribe: subscribeDocumentVisibility,
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
};

/** Keep a periodic callback asleep while hidden and refresh as soon as it returns. */
export function startVisibleInterval(
  callback: () => void,
  intervalMs: number,
  env: VisibleIntervalEnv = DEFAULT_VISIBLE_INTERVAL_ENV,
): () => void {
  let timer: unknown | null = null;
  let disposed = false;

  const stop = (): void => {
    if (timer !== null) {
      env.clearInterval(timer);
      timer = null;
    }
  };
  const start = (refresh: boolean): void => {
    if (disposed || !env.isVisible() || timer !== null) return;
    if (refresh) callback();
    timer = env.setInterval(callback, intervalMs);
  };
  const unsubscribe = env.subscribe(() => {
    if (env.isVisible()) start(true);
    else stop();
  });
  start(false);

  return () => {
    disposed = true;
    stop();
    unsubscribe();
  };
}
