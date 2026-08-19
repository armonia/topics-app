/**
 * «Apri con Topics», lato client: la coda del guscio diventa tab.
 *
 * Il guscio Rust non consegna il path: lo ACCODA e suona il campanello
 * (`topics:os-open-path`). Qui si risponde al campanello, si svuota la coda e
 * si apre. Due sorgenti, una porta sola:
 *
 *  · il campanello, per il path arrivato ad app viva (il caso istantaneo);
 *  · il MONTAGGIO, per il path arrivato prima che questa pagina esistesse.
 *    È il lancio a freddo, ed è il motivo per cui la coda esiste: senza,
 *    l'evento sarebbe stato dispatchato in una webview che non c'era.
 *
 * Aprire NON è deciso qui: il path va al server, che guarda il disco e
 * risponde con un `TabTarget` (`shared/os-open-path.ts` è la regola). Poi
 * `openTabInApp` fa il resto, ed è la STESSA funzione del permalink incollato
 * in chat: apre la finestra di progetto, aspetta che monti e mette a fuoco il
 * file. Un secondo percorso avrebbe dovuto reimparare quell'attesa.
 */
import type { TabTarget } from '../../../shared/tab-link';
import { openTabInApp } from './tabLink';
import { isTauri } from './shell';
import { tauriInvoke } from './shell/tauri';

/** Il campanello che il guscio suona quando ha accodato qualcosa. */
export const OS_OPEN_PATH_EVENT = 'topics:os-open-path';

/**
 * Cosa si dice a chi ha chiesto di aprire e non vedrà aprirsi niente.
 * Il caso vero: un file spostato o cancellato dopo l'ultima volta che il
 * Finder ne ha disegnato l'icona. Silenzio sarebbe peggio, perché il gesto
 * (doppio click) è identico a quello riuscito.
 */
export const OS_OPEN_MISS_MESSAGE = 'Questo percorso non esiste più';

export interface OsOpenDeps {
  /** Svuota la coda del guscio. */
  take: () => Promise<string[]>;
  /** Path → tab da aprire (o null: niente da aprire). */
  resolve: (path: string) => Promise<TabTarget | null>;
  /** Apri la tab. */
  open: (target: TabTarget) => void;
  /** Un messaggio per chi ha chiesto di aprire e non vedrà aprirsi niente. */
  notify?: (message: string) => void;
}

/**
 * Quante aperture per giro. Chi seleziona venti file e preme Invio si aspetta
 * di lavorare, non di trovare venti tab: oltre il tetto si apre il resto la
 * prossima volta non è vero, si lascia cadere. Il tetto è alto abbastanza da
 * non toccare mai il gesto normale (uno o due file).
 */
const MAX_PER_DRAIN = 8;

/**
 * Svuota la coda e apre. Sequenziale di proposito: due `openTabInApp` nello
 * stesso tick sullo stesso progetto si contendono il mount della finestra, e
 * il secondo file finirebbe nella finestra che il primo sta ancora aprendo.
 */
export async function drainOsOpenPaths(deps: OsOpenDeps): Promise<number> {
  let paths: string[];
  try {
    paths = await deps.take();
  } catch {
    return 0; // fuori dal guscio, o comando assente in un bundle vecchio
  }
  if (!Array.isArray(paths) || paths.length === 0) return 0;

  let opened = 0;
  for (const path of paths.slice(0, MAX_PER_DRAIN)) {
    let target: TabTarget | null = null;
    try {
      target = await deps.resolve(path);
    } catch {
      target = null;
    }
    if (!target) {
      deps.notify?.(OS_OPEN_MISS_MESSAGE);
      continue;
    }
    deps.open(target);
    opened++;
  }
  return opened;
}

/** Il verdetto del server sul path: cosa aprire, o niente. */
export async function resolveOsPathOnServer(path: string): Promise<TabTarget | null> {
  const res = await fetch(`/api/projects/resolve-open?path=${encodeURIComponent(path)}`);
  if (!res.ok) return null;
  const body = (await res.json()) as { target?: TabTarget | null };
  return body?.target ?? null;
}

/** Le dipendenze vere: coda del guscio, sonda del server, bus delle tab. */
export function defaultOsOpenDeps(notify?: (m: string) => void): OsOpenDeps {
  return {
    take: () => tauriInvoke<string[]>('take_os_open_paths'),
    resolve: resolveOsPathOnServer,
    open: (target) => openTabInApp(target, { notify }),
    notify,
  };
}

/**
 * Attacca il ponte. Torna la funzione per staccarlo.
 *
 * Fuori da Tauri non fa niente e non registra niente: nel browser non esiste
 * nessun sistema operativo che consegni path a questa pagina.
 */
export function installOsOpenPathBridge(deps: OsOpenDeps = defaultOsOpenDeps()): () => void {
  if (!isTauri) return () => {};
  const drain = () => { void drainOsOpenPaths(deps); };
  window.addEventListener(OS_OPEN_PATH_EVENT, drain);
  // Il giro al montaggio è il lancio a freddo: la coda può essere già piena
  // da prima che questa pagina esistesse.
  drain();
  return () => window.removeEventListener(OS_OPEN_PATH_EVENT, drain);
}
