/**
 * Quale composer riceve il testo iniettato da fuori (`chat:insert-text`,
 * `chat:attach-image`).
 *
 * Il problema. Quegli eventi sono `window`-level, cioè una BROADCAST: li sente
 * ogni `ChatInput` montato. E le pane nascoste restano montate (PaneKeepAlive),
 * quindi selezionare un elemento nel browser scriveva la stessa riga dentro
 * TUTTE le chat aperte — comprese quelle che non stai guardando. Finché era una
 * riga di testo era una seccatura; con 4.2 diventa anche uno screenshot
 * allegato a chat con cui non c'entra niente.
 *
 * La soglia giusta non è «quella focalizzata»: quando clicchi nel browser il
 * focus ce l'ha la pane del browser, nessuna chat. È «l'ULTIMA che hai usato»,
 * che è anche quella a cui stai per parlare.
 *
 * Registro modulare e non store zustand di proposito: non c'è niente da
 * ri-renderizzare: chi legge lo fa dentro un handler di evento.
 */

const mounted = new Set<string>();
let lastFocused: string | null = null;

export const chatFocus = {
  /** Un composer entra in scena. Il primo che arriva è anche il destinatario
   *  di default: senza, un'iniezione prima di qualunque click andrebbe persa. */
  register(id: string): void {
    mounted.add(id);
    if (lastFocused === null) lastFocused = id;
  },

  unregister(id: string): void {
    mounted.delete(id);
    if (lastFocused === id) {
      const next = mounted.values().next();
      lastFocused = next.done ? null : next.value;
    }
  },

  focus(id: string): void {
    if (mounted.has(id)) lastFocused = id;
  },

  /** Questo composer è quello che deve prendersi un'iniezione esterna? */
  isRecipient(id: string): boolean {
    if (!mounted.has(id)) return false;
    if (mounted.size === 1) return true;
    return lastFocused === id;
  },

  /** Solo per i test: azzera il registro tra un caso e l'altro. */
  _reset(): void {
    mounted.clear();
    lastFocused = null;
  },
};
