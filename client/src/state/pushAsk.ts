/**
 * QUANDO chiedere il permesso alle notifiche.
 *
 * Non al primo avvio. Un cartello che compare prima che tu abbia fatto qualcosa
 * si nega per riflesso, e un permesso negato su iOS non si riapre più da dentro
 * l'app: si va a chiuderlo nelle impostazioni di sistema. Il costo di chiedere
 * male non è «l'utente dice no adesso», è «l'utente non potrà più dire sì da
 * qui».
 *
 * Quindi si chiede DOPO un gesto che le notifiche servono a completare: hai
 * appena mandato un messaggio a un agente, cioè hai appena creato un'attesa. È
 * il momento in cui la frase «ti avviso quando finisce» è una risposta a una
 * domanda che ti sei già fatto, invece di una richiesta di permesso a freddo.
 */
import { create } from 'zustand';

const DECLINED_KEY = 'topics.push.askDeclined';

interface PushAskState {
  /** Un gesto che crea un'attesa è appena avvenuto. */
  armed: boolean;
  /** L'utente ha detto «non ora» in questa installazione. */
  declined: boolean;
  armPushAsk: () => void;
  declinePushAsk: () => void;
  disarmPushAsk: () => void;
}

function readDeclined(): boolean {
  try { return localStorage.getItem(DECLINED_KEY) === '1'; } catch { return false; }
}

export const usePushAskStore = create<PushAskState>((set) => ({
  armed: false,
  declined: readDeclined(),
  armPushAsk: () => set({ armed: true }),
  declinePushAsk: () => {
    // Il rifiuto è del DISPOSITIVO e persiste: ri-proporre la stessa richiesta a
    // ogni messaggio è il modo più veloce di trasformare un «non ora» in un
    // «negato» di sistema, che è irreversibile da qui.
    try { localStorage.setItem(DECLINED_KEY, '1'); } catch { /* storage non scrivibile: vale per questa sessione */ }
    set({ armed: false, declined: true });
  },
  disarmPushAsk: () => set({ armed: false }),
}));

/** Si arma da fuori React: il sito di chiamata è l'invio di un messaggio. */
export function armPushAsk(): void {
  usePushAskStore.getState().armPushAsk();
}

/**
 * L'invito si mostra?
 *
 * Puro, perché è la regola che vale la pena tenere onesta: tre condizioni, tutte
 * necessarie. `canSubscribe` viene da `describePushState` e porta dentro di sé
 * tutti i casi in cui chiedere sarebbe una bugia (permesso negato, iPhone senza
 * PWA installata, browser senza push, guscio nativo).
 */
export function shouldOfferPush(input: {
  armed: boolean;
  declined: boolean;
  canSubscribe: boolean;
}): boolean {
  return input.armed && !input.declined && input.canSubscribe;
}
