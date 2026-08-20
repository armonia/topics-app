/**
 * LE VOCI MISURATE dell'inventario: MB veri, da processi veri.
 *
 * PERCHE' SEPARATO DA `featureWeightSources`. Quelle voci sono CONTEGGI e vivono
 * in un registro: si dichiarano da sole, senza chiedere niente a nessuno. Queste
 * sono MB, arrivano da fuori (il campionamento della flotta e delle webview) e
 * dipendono da un dato che puo' mancare — sul telefono non c'e' shell, e senza
 * server non c'e' flotta. Tenerle nello stesso registro avrebbe voluto dire
 * inventare un modo per «registrare» un dato che arriva a strappi.
 *
 * NESSUNA LETTURA IN PIU'. Tutto cio' che serve qui e' gia' stato campionato
 * per la status bar e per i tooltip delle tab: questa funzione e' pura e
 * TRASFORMA, non misura. E' la regola di RES-ATTR-04 — il costo della misura non
 * cresce col numero di cose misurate — applicata a una superficie nuova.
 */

import type { VocePeso } from './featureWeight';

/** Le sessioni terminale come le riporta la flotta. */
export interface SessioneMisurata {
  sessionId: string;
  name: string;
  memoryMB: number;
  processCount: number;
}

/** Una radice del lato server (pty-bridge, ai-bridge, il server stesso). */
export interface RadiceMisurata {
  kind: string;
  memoryMB: number;
  processCount: number;
}

export interface IngressiMisurati {
  /** Le sessioni PTY (terminali e CLI degli agenti), dal server. */
  sessioni: readonly SessioneMisurata[];
  /** Le pane browser, dalla shell: una webview = un processo WebContent. */
  browser: readonly { label: string; memoryMB: number }[];
  /** Le radici del lato server. */
  radici: readonly RadiceMisurata[];
  /** Il lavoro lanciato dagli agenti (npm install, build, test). */
  scriptsMB: number;
  scriptsProcessCount: number;
}

/**
 * Quanto un gruppo deve pesare per meritarsi una riga.
 *
 * Sotto un megabyte la voce direbbe «0 MB», che e' rumore con l'aria di un dato.
 * Non e' una soglia di prodotto tarata a occhio: e' il punto sotto il quale il
 * numero arrotondato smette di dire qualcosa.
 */
const MIN_MB = 1;

/**
 * Le voci misurate, aggregate per funzionalita'.
 *
 * AGGREGA invece di elencare: dodici terminali fanno DODICI righe, e un elenco
 * di dodici righe da 30 MB nasconde la riga da 700. La funzionalita' e' «i tuoi
 * terminali», e il dettaglio di quale sia il piu' pesante sta nel `detail` —
 * dove lo cerca chi vuole agire, non davanti a chi vuole capire.
 */
export function vociMisurate(x: IngressiMisurati): VocePeso[] {
  const out: VocePeso[] = [];

  if (x.sessioni.length > 0) {
    let mb = 0;
    let proc = 0;
    let maggiore = '';
    let maxMb = 0;
    for (const s of x.sessioni) {
      mb += s.memoryMB;
      proc += s.processCount;
      if (s.memoryMB > maxMb) { maxMb = s.memoryMB; maggiore = s.name || s.sessionId; }
    }
    if (mb >= MIN_MB) {
      out.push({
        id: 'fleet.sessions', label: 'Terminali e sessioni', natura: 'misurato',
        peso: {
          entries: x.sessioni.length, memoryMB: mb, processCount: proc,
          detail: { piuPesante: maggiore, mbDelPiuPesante: maxMb },
        },
      });
    }
  }

  if (x.browser.length > 0) {
    const mb = x.browser.reduce((a, b) => a + b.memoryMB, 0);
    if (mb >= MIN_MB) {
      out.push({
        id: 'shell.browserPanes', label: 'Pannelli browser', natura: 'misurato',
        peso: { entries: x.browser.length, memoryMB: mb, processCount: x.browser.length },
      });
    }
  }

  // Le radici del lato server, ognuna con la sua riga: sono cose diverse
  // (il server, il ponte dei terminali, quello dell'AI) e sommarle direbbe
  // «lato server: 400 MB», che e' il numero che la barra gia' mostra.
  for (const r of x.radici) {
    if (r.memoryMB < MIN_MB) continue;
    out.push({
      id: `fleet.root.${r.kind}`,
      label: etichettaRadice(r.kind),
      natura: 'misurato',
      peso: { entries: 1, memoryMB: r.memoryMB, processCount: r.processCount },
    });
  }

  // GLI SCRIPT DEGLI AGENTI. Sono il terzo asse della flotta ed e' bene che
  // abbiano una riga propria: un `npm install` da 700 MB in corso e' la
  // spiegazione piu' probabile di un numero che si e' gonfiato all'improvviso,
  // ed e' anche l'unica voce dell'elenco che sparisce da sola.
  if (x.scriptsMB >= MIN_MB) {
    out.push({
      id: 'fleet.scripts', label: 'Comandi lanciati dagli agenti', natura: 'misurato',
      peso: { entries: x.scriptsProcessCount, memoryMB: x.scriptsMB, processCount: x.scriptsProcessCount },
    });
  }

  return out;
}

/** Il nome del ponte come lo riconosce chi usa l'app. Un `kind` sconosciuto
 *  passa cosi' com'e': meglio una riga con un nome tecnico che nessuna riga. */
function etichettaRadice(kind: string): string {
  switch (kind) {
    case 'server': return 'Server di Topics';
    case 'pty-bridge': return 'Ponte dei terminali';
    case 'ai-bridge': return 'Ponte AI';
    case 'webrtc-bridge': return 'Ponte WebRTC';
    default: return kind;
  }
}
