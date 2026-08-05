// Staccare un GRUPPO in una finestra sua.
//
// Il fratello di `popOutTopic`, e la ragione per cui quello resta piccolo: una
// pop-out di CHAT (`?topics=a,b`) è una vista morta — nessun bridge del
// pane-store, niente persistenza, la finestra che si chiude È il cambio di
// stato. Un GRUPPO invece è una cosa viva: ha un nome, tab di ogni tipo, una
// griglia sua, e deve poter aprire e chiudere schede come qualunque finestra.
//
// Quindi la finestra di un gruppo NON è una pop-out: è l'app intera, con i suoi
// bridge accesi, inchiodata a uno Spazio dalla query `?space=<id>` (vedi
// `lib/windowRole.ts`). Due finestre che scrivono lo stesso pane-store sono
// esattamente il caso "due dispositivi", che il negozio già regge con la LWW e
// il `server_seq`: non serve un secondo modello.
import { isTauri } from './shell/index';
import { tauriInvoke } from './shell/tauri';

/** URL di boot di una finestra-gruppo. Unica forma, un posto solo. */
export function spaceWindowUrl(spaceId: string, origin = window.location.origin): string {
  return `${origin}/?space=${encodeURIComponent(spaceId)}`;
}

/**
 * Apre `spaceId` in una finestra sua. Ritorna true se una finestra è davvero
 * nata (o è stata riusata). Nessun effetto sul pane-store: la membership delle
 * tab non cambia, cambia solo CHI la disegna.
 */
export async function popOutSpace(spaceId: string): Promise<boolean> {
  if (!spaceId) return false;
  if (isTauri) {
    try {
      const label = await tauriInvoke<string>('window_detach_space', { space: spaceId });
      return typeof label === 'string' && label.length > 0;
    } catch {
      return false;
    }
  }
  // Web: `window.open` con la stessa URL. Il nome della finestra è lo spazio,
  // così un secondo click riusa quella già aperta invece di clonarla.
  const win = window.open(spaceWindowUrl(spaceId), `space-${spaceId}`, 'width=1100,height=760');
  return !!win;
}

/**
 * Porta in primo piano la finestra di un gruppo staccato. `false` = quella
 * finestra non esiste più su QUESTA macchina (chiusa, o è di un altro
 * dispositivo): chi chiama decide il ripiego (di solito: commutare qui).
 */
export async function focusSpaceWindow(windowLabel: string): Promise<boolean> {
  if (!windowLabel) return false;
  if (!isTauri) {
    // Sul web non si può alzare una finestra per nome senza riaprirla, e
    // riaprirla la ricaricherebbe: meglio dire di no e lasciare il ripiego.
    return false;
  }
  try {
    return (await tauriInvoke<boolean>('window_focus_label', { label: windowLabel })) === true;
  } catch {
    return false;
  }
}
