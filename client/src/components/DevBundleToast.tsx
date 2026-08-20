/**
 * DevBundleToast — «il bundle servito è cambiato».
 *
 * Il rimpiazzo MANUALE del vecchio auto-reload silenzioso di devBundleReload
 * (vedi lib/devBundleReload.ts, «gestiamo meglio l'hot-reload» 2026-07-20).
 * Ascolta un evento solo, `BUNDLE_STALE_EVENT`, emesso SIA dal controllo di
 * revisione in sviluppo SIA dalla guardia sugli errori di chunk, e mostra un
 * avviso azionabile. La finestra non si ricarica MAI senza un clic.
 *
 * Resta un componente separato da UpdaterToast di proposito: quello guida
 * l'aggiornamento NATIVO (scarica e riavvia una release firmata), questo è il
 * ricarico in pagina di un bundle ricostruito. Cicli di vita diversi, stesso
 * linguaggio visivo — che adesso è letteralmente lo stesso componente,
 * `SidebarUpdateBanner`, e sono i suoi due `kind` a dire quale dei due mondi
 * sta parlando: qui «Aggiornamento automatico», là «Nuova versione».
 *
 * La collocazione (dentro la sidebar, a tutta larghezza) e il perché del
 * cambio stanno in `SidebarUpdateBanner`.
 */
import { useEffect, useState } from 'react';
import { useT } from '@/hooks/useT';
import { RefreshCw } from 'lucide-react';
import { BUNDLE_STALE_EVENT, reloadForNewBundle } from '@/lib/devBundleReload';
import { SidebarUpdateBanner } from './Shared/SidebarUpdateBanner';

export function DevBundleToast() {
  const tr = useT();
  const [stale, setStale] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const onStale = () => {
      setStale(true);
      // A fresh signal re-surfaces the prompt even if a previous one was
      // dismissed — the bundle moved again, the user should know.
      setDismissed(false);
    };
    window.addEventListener(BUNDLE_STALE_EVENT, onStale);
    return () => window.removeEventListener(BUNDLE_STALE_EVENT, onStale);
  }, []);

  if (!stale || dismissed) return null;

  return (
    <SidebarUpdateBanner
      kind="build"
      testId="bundle-stale-toast"
      icon={<RefreshCw size={14} className="text-primary" />}
      // Il titolo dice il FATTO, l'occhiello dice il genere. Prima entrambi i
      // banner scrivevano «Nuova versione disponibile», quindi la frase non
      // distingueva una build di lavoro da una release firmata — che è la
      // differenza fra «ricarica quando ti va» e «riavvia l'app».
      title={tr('dev.newerBuild')}
      onDismiss={() => setDismissed(true)}
    >
      <button
        onClick={() => reloadForNewBundle()}
        className="mt-1 text-primary underline underline-offset-2 hover:no-underline"
        data-testid="bundle-stale-reload"
      >
        Ricarica
      </button>
    </SidebarUpdateBanner>
  );
}
