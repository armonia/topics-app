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
import { beginNativeViewMovesToAnotherWindow } from './shell/nativeBrowserViews';

/**
 * I gruppi che QUESTA finestra ha rivendicato a mano.
 *
 * Serve a far vincere l'utente su un dato vecchio. La regola normale è: se un
 * gruppo vive in un'altra finestra, questa non lo disegna e ci manda là. Ma
 * quando il clic sulla card ha PROVATO a portare davanti quella finestra e ha
 * fallito (chiusa, di un altro dispositivo), il ripiego è aprirlo qui — e la
 * presenza, che ci mette un istante a scoprire il funerale, direbbe ancora
 * "vive di là" e rimbalzerebbe indietro l'utente. La rivendicazione è la
 * memoria di quel "no, lo voglio qui".
 */
const claimedSpaces = new Set<string>();

/** Questa finestra si prende il gruppo, anche se la presenza dice altro. */
export function claimSpaceLocally(spaceId: string): void {
  claimedSpaces.add(spaceId);
}

/** L'ha rivendicato questa finestra? */
export function isSpaceClaimedLocally(spaceId: string): boolean {
  return claimedSpaces.has(spaceId);
}

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
  // Se lo si stacca, non è più "voglio tenerlo qui".
  claimedSpaces.delete(spaceId);
  if (isTauri) {
    // Same reason as `popOutTopics`: the group's pages must still be alive when
    // the new window asks for them, so it gets the same native views.
    beginNativeViewMovesToAnotherWindow();
    try {
      const label = await tauriInvoke<string>('window_detach_space', { space: spaceId });
      const ok = typeof label === 'string' && label.length > 0;
      if (!ok) console.error('[space] detach: risposta vuota dal guscio', label);
      return ok;
    } catch (e) {
      // NON si ingoia. Un `catch {}` muto qui è costato una diagnosi intera:
      // il comando falliva, l'utente vedeva un clic che non faceva niente, e
      // nel log non compariva nulla da nessuna parte.
      console.error('[space] detach fallito:', e);
      return false;
    }
  }
  console.warn('[space] detach: non siamo sotto Tauri, ripiego su window.open');
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

/**
 * Chiude la finestra di un gruppo staccato — cioè se lo riprende questa.
 *
 * Ritorna true se la finestra c'era ed è stata chiusa. Le tab non si toccano:
 * la membership vive nel pane-store, la finestra è solo chi le disegna.
 */
export async function closeSpaceWindow(windowLabel: string): Promise<boolean> {
  if (!windowLabel || !isTauri) return false;
  try {
    return (await tauriInvoke<boolean>('window_close_label', { label: windowLabel })) === true;
  } catch (e) {
    console.error('[space] chiusura della finestra fallita:', e);
    return false;
  }
}
