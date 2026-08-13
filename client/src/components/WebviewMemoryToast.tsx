/**
 * WebviewMemoryToast — «le webview si sono prese la macchina, e chiuderle non
 * serve».
 *
 * Perché esiste: chiudere una pane browser NON restituisce la sua memoria. wry
 * non dealloca mai la WKWebView, il processo WebContent resta vivo per sempre e
 * l'unica cura è riavviare Topics. Misurato su un Mac da 32 GB: 15 WebView per
 * 9,7 GB, primo consumatore della macchina, swap al 96%. Fin qui l'app non ne
 * diceva niente, quindi il guasto arrivava all'utente come «il Mac è lento» e la
 * cosa più ovvia da fare (chiudere le pane) era anche l'unica che non funziona.
 * Le misure e lo stato di monte stanno in `state/pane/residency/policy.ts:75`,
 * la soglia e la sua taratura in `lib/webviewMemoryWarning.ts`.
 *
 * Informa e basta: niente sfratto automatico, niente riavvio automatico. Sfrattare
 * per giunta peggiorerebbe le cose (stesso file: sfratto e rientro non liberano
 * niente e aggiungono un processo permanente), e riavviare al posto dell'utente
 * significa decidere noi quando buttare via il suo lavoro in corso.
 *
 * Sta nella stessa superficie degli altri due avvisi persistenti della colonna
 * (`SidebarUpdateBanner`, con `UpdaterToast` e `DevBundleToast`), col suo
 * occhiello: «Memoria», non «Aggiornamento».
 */
import { useState } from 'react';
import { HardDrive } from 'lucide-react';
import { usePerfMetrics } from '@/hooks/usePerfMetrics';
import {
  WEBVIEW_MEMORY_WARNING_INITIAL,
  dismissWebviewMemoryWarning,
  formatWebviewMemoryGB,
  nextWebviewMemoryWarning,
} from '@/lib/webviewMemoryWarning';
import { SidebarUpdateBanner } from './Shared/SidebarUpdateBanner';

/**
 * 20 secondi, e sono tanti apposta. `perf_metrics` percorre l'albero dei
 * processi lato Rust, e questo poll è l'unico che gira anche quando nessuno sta
 * guardando un numero. La cosa che misura cresce nell'arco di ore e non scende
 * mai: campionarla più spesso non cambierebbe una sola decisione, aggiungerebbe
 * solo lavoro alla macchina che stiamo dicendo essere sotto pressione. Il tick
 * si salta già da solo a finestra nascosta (vedi `usePerfMetrics`).
 */
const POLL_MS = 20000;

export function WebviewMemoryToast() {
  const perf = usePerfMetrics(true, POLL_MS);
  // Una lettura `partial` copre la sola shell (Windows e Linux non hanno
  // `responsibility_get_pid_responsible_for_pid`), quindi lì `rendererMB` non è
  // la memoria delle webview e non deve decidere niente: vale come «nessuna
  // misura», esattamente come il `null` che l'hook restituisce sul web.
  const rendererMB = perf && !perf.partial ? perf.memory.rendererMB : null;
  const [state, setState] = useState(WEBVIEW_MEMORY_WARNING_INITIAL);

  // Lo stato si aggiusta DURANTE il render, non dentro un effetto: è il pattern
  // «adjusting state when props change» della documentazione React, e qui è
  // sicuro per una proprietà costruita apposta in `nextWebviewMemoryWarning`.
  // Quella funzione ritorna `prev` per IDENTITÀ quando il campione non cambia
  // niente, quindi la condizione qui sotto è falsa quasi sempre e non esiste un
  // ciclo. React rifà il render subito, senza committare quello intermedio: un
  // render in meno per campione, e nessuna deroga al linter da spiegare.
  const next = nextWebviewMemoryWarning(state, rendererMB);
  if (next !== state) setState(next);

  if (!next.visible || rendererMB === null) return null;

  return (
    <SidebarUpdateBanner
      kind="memory"
      testId="webview-memory-warning"
      icon={<HardDrive size={14} className="text-amber-800 dark:text-amber-400" />}
      // Il titolo dice «webview», non «pane browser», perché il numero le
      // comprende tutte: le pane aperte, quelle già chiuse che non sono mai
      // morte, e la finestra della UI. Attribuirlo alle sole pane sarebbe più
      // comodo da leggere e falso.
      title={`Le webview tengono ${formatWebviewMemoryGB(rendererMB)} GB`}
      onDismiss={() => setState((prev) => dismissWebviewMemoryWarning(prev, rendererMB))}
    >
      <p className="mt-1 text-app-text-muted">
        Chiuderle non restituisce la memoria: è un difetto noto di wry a monte, la
        WKWebView resta viva anche dopo che la pane è sparita. Il conto comprende le
        pane browser aperte, quelle già chiuse e la finestra di Topics. Riavviare
        Topics la libera tutta.
      </p>
    </SidebarUpdateBanner>
  );
}
