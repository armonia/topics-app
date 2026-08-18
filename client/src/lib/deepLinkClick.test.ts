/**
 * UN LINK CHE NON PORTA DA NESSUNA PARTE DEVE ALMENO DIRLO.
 *
 * IL GUASTO. Il click su un link self-origin di un markdown ha tre esiti, e il
 * terzo era MUTO: quando la rotta in-app apriva qualcosa (la finestra di
 * progetto) e poi il secondo salto si arrendeva, non succedeva più niente —
 * niente pane, niente avviso, niente ripiego. Era una scelta, motivata da una
 * premessa che oggi è falsa («il valore del context dei toast non è memoizzato,
 * quindi un `useToast()` qui dentro renderebbe ogni link un consumatore che si
 * ri-renderizza»): l'API dei toast vive ora in un context la cui identità non
 * cambia mai dopo il mount.
 *
 * LA BARRA, e sono due direzioni opposte che nessuna asserzione singola prende:
 *   • vicolo cieco SENZA niente aperto → si apre fuori, e NON si avvisa (il
 *     contenuto si vede, che è il punto);
 *   • vicolo cieco DOPO che qualcosa è partito → si avvisa, e NON si apre fuori
 *     (aprire fuori lascerebbe una seconda copia completa di Topics accanto
 *     alla finestra appena aperta).
 */
import { describe, expect, test } from 'bun:test';
import { openDeepLinkFromClick, type DeepLinkClickDeps } from './deepLinkClick';
import type { DeepLinkClickRoute } from './tabLink';
import type { TabTarget } from '../../../shared/tab-link';

interface Log {
  tasks: string[];
  external: string[];
  warnings: string[];
}

const TAB: TabTarget = { kind: 'chat', key: 't1' };

/** `openTab` è la simulazione dell'unica cosa che conta: la SEQUENZA con cui
 *  `openTabInApp` chiama `onRouted` e `notify`. */
function deps(
  route: DeepLinkClickRoute,
  openTab: DeepLinkClickDeps['openTab'],
): { deps: DeepLinkClickDeps; log: Log } {
  const log: Log = { tasks: [], external: [], warnings: [] };
  return {
    log,
    deps: {
      route: () => route,
      openTask: (t) => log.tasks.push(t.taskId),
      openTab,
      openExternal: (href) => log.external.push(href),
      warn: (m) => log.warnings.push(m),
    },
  };
}

describe('openDeepLinkFromClick', () => {
  test('vicolo cieco senza niente aperto: si apre FUORI, in silenzio', () => {
    const { deps: d, log } = deps({ via: 'tab', target: TAB }, (_t, opts) => {
      opts.notify('Questa tab non esiste più');
    });
    openDeepLinkFromClick('http://x/tab/topic/t1', d);
    expect(log.external).toEqual(['http://x/tab/topic/t1']);
    expect(log.warnings).toEqual([]);
  });

  test('IL GUASTO: aperto a metà e poi arreso → si AVVISA, e non si apre fuori', () => {
    const { deps: d, log } = deps({ via: 'tab', target: TAB }, (_t, opts) => {
      opts.onRouted();                       // la finestra di progetto è partita
      opts.notify('Questa tab non esiste più'); // il secondo salto si è arreso
    });
    openDeepLinkFromClick('http://x/tab/file/t1', d);
    // Prima: nessuna delle due righe. Il click non faceva e non diceva niente.
    expect(log.warnings).toEqual(['Questa tab non esiste più']);
    expect(log.external).toEqual([]);
  });

  test('rotta riuscita: nessun avviso e nessun browser esterno', () => {
    const { deps: d, log } = deps({ via: 'tab', target: TAB }, (_t, opts) => {
      opts.onRouted();
    });
    openDeepLinkFromClick('http://x/tab/topic/t1', d);
    expect(log).toEqual({ tasks: [], external: [], warnings: [] });
  });

  test('un /task/<id> lo possiede il drawer: né avvisi né ripieghi', () => {
    const { deps: d, log } = deps({ via: 'task', target: { taskId: 'abc' } }, () => {
      throw new Error('la rotta task non deve passare da openTab');
    });
    openDeepLinkFromClick('http://x/task/abc', d);
    expect(log.tasks).toEqual(['abc']);
    expect(log.external).toEqual([]);
  });

  test('non è roba nostra (o la finestra è staccata): browser esterno', () => {
    const { deps: d, log } = deps({ via: 'external' }, () => {
      throw new Error('la rotta external non deve passare da openTab');
    });
    openDeepLinkFromClick('https://example.com/', d);
    expect(log.external).toEqual(['https://example.com/']);
    expect(log.warnings).toEqual([]);
  });
});
