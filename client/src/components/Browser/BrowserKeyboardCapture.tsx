/**
 * Il campo che riceve davvero la tastiera nel pane browser.
 *
 * La pagina remota, qui, non è scrivibile: nel co-browse DOM è un mirror con
 * `pointer-events:none`, nel ramo video è un flusso di pixel. Quindi le battute
 * le prende un campo NOSTRO, nascosto, e ciò che scrive viene rilanciato alla
 * pagina vera. Ne segue una cosa che dal telefono si vede subito: la tastiera
 * che iOS apre è quella di QUESTO campo, non quella del campo che hai toccato.
 * Finché è stato una <textarea> nuda, email/numero/password davano tutti la
 * tastiera di testo — il difetto segnalato il 12/08.
 *
 * Due regole, e sono entrambe qui dentro:
 *  1. prima del focus il campo si veste come il campo remoto
 *     (`keyboardProfileFor` → `applyKeyboardProfile`);
 *  2. il font non scende MAI sotto 16px, perché sotto quella soglia iOS ingrandisce
 *     la pagina per «adattare» il campo a fuoco e non la rimpicciolisce più —
 *     ed era un campo da 1×1px, quindi lo zoom era quello massimo.
 *
 * Sta in un componente condiviso perché le due superfici (mirror DOM e video)
 * devono comportarsi uguale: quando la cattura viveva dentro una sola delle due,
 * l'altra semplicemente non faceva salire nessuna tastiera.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import {
  DEFAULT_KEYBOARD_PROFILE,
  applyKeyboardProfile,
  keyboardProfileFor,
  type KeyboardProfile,
} from '../../lib/browserKeyboardProfile';

/** Named keys relayed to the source as key presses (the rest go through as text). */
const RELAYED_KEYS = new Set([
  'Enter', 'Backspace', 'Delete', 'Tab', 'Escape',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
]);

/**
 * La soglia dello zoom automatico di iOS. A 16px non scatta; a 15 sì, e la
 * pagina resta ingrandita. Non è una scelta estetica — il campo è invisibile —
 * ma il modo di NON far scalare la shell al primo tocco.
 */
export const CAPTURE_FONT_SIZE_PX = 16;

export type SendInput = (
  action: 'click' | 'type' | 'scroll' | 'mousemove' | 'keypress',
  payload: { x?: number; y?: number; text?: string; key?: string; deltaX?: number; deltaY?: number; button?: 'left' | 'right' | 'middle' },
) => void;

export interface BrowserKeyboardCaptureHandle {
  /**
   * Mette a fuoco per il campo remoto toccato. `target` è il nodo del mirror
   * sotto il dito (o `null` quando non lo sappiamo, es. sul flusso video).
   *
   * `requireField` distingue le due mani: col dito la tastiera deve salire SOLO
   * su un campo di scrittura (toccare un bottone non deve aprirla), col mouse
   * la cattura resta sempre viva perché è anche la presa dei tasti hardware.
   */
  focusForField(target: Element | null, opts?: { requireField?: boolean }): void;
  /** Toglie il fuoco — su mobile è ciò che fa RIENTRARE la tastiera. */
  blur(): void;
}

interface Props {
  /** Relay input to the source page (page-CSS px). */
  sendInput: SendInput;
  /** Mentre un agente guida, la cattura non rilancia nulla. */
  suppressed: boolean;
}

/**
 * Campo di cattura nascosto. Invisibile e senza area cliccabile, ma un vero
 * <input>: è l'unico modo di far salire la tastiera di sistema su iOS.
 */
const BrowserKeyboardCapture = forwardRef<BrowserKeyboardCaptureHandle, Props>(
  function BrowserKeyboardCapture({ sendInput, suppressed }, ref) {
    const kbdRef = useRef<HTMLInputElement | null>(null);
    const suppressedRef = useRef(suppressed);
    const sendInputRef = useRef(sendInput);
    useEffect(() => { suppressedRef.current = suppressed; }, [suppressed]);
    useEffect(() => { sendInputRef.current = sendInput; }, [sendInput]);

    useImperativeHandle(ref, () => ({
      focusForField(target, opts) {
        const el = kbdRef.current;
        if (!el) return;
        // `null` NON vuol dire «campo di testo»: vuol dire «non lo so». Col dito
        // si tace, col mouse si riprende comunque la presa dei tasti hardware.
        const profile: KeyboardProfile | null = target ? keyboardProfileFor(target) : null;
        if (!profile && opts?.requireField) {
          // Toccato qualcosa che non si scrive: nessuna tastiera, e se ne era
          // aperta una si chiude — com'è in un browser vero.
          if (document.activeElement === el) el.blur();
          return;
        }
        // Gli attributi vanno scritti PRIMA del focus: iOS li legge quando apre
        // la tastiera, e a tastiera aperta non la ridisegna.
        applyKeyboardProfile(el, profile || DEFAULT_KEYBOARD_PROFILE);
        try { el.focus({ preventScroll: true }); } catch { el.focus(); }
      },
      blur() {
        kbdRef.current?.blur();
      },
    }), []);

    const onKeyDown = useCallback((e: React.KeyboardEvent) => {
      e.stopPropagation(); // don't double-relay via the panel's onKeyDown
      if (suppressedRef.current) { e.preventDefault(); return; }
      // Meta/Ctrl combos stay native: ⌘C copies a (selection-mode) selection, ⌘V
      // paste lands in beforeinput below and is relayed there.
      if (e.metaKey || e.ctrlKey) return;
      if (RELAYED_KEYS.has(e.key)) {
        e.preventDefault();
        sendInput('keypress', { key: e.key });
      } else if (e.key.length === 1) {
        e.preventDefault();
        sendInput('type', { text: e.key });
      }
      // Dead/Process/Unidentified fall through: IME composes; the composition +
      // soft-keyboard text lands in beforeinput / compositionend below.
    }, [sendInput]);

    // `beforeinput` carries the real InputEvent.inputType (React's synthetic
    // onBeforeInput does not), and covers mobile soft keyboards + paste + IME — so
    // it's attached as a NATIVE listener on the field.
    useEffect(() => {
      const input = kbdRef.current;
      if (!input) return;
      const onBeforeInput = (ev: Event) => {
        const ie = ev as InputEvent;
        ev.stopPropagation();
        // insertCompositionText is not cancelable per spec — relayed at compositionend.
        if (ie.inputType === 'insertCompositionText') return;
        ev.preventDefault();
        if (suppressedRef.current) return;
        const send = sendInputRef.current;
        switch (ie.inputType) {
          case 'insertText':
          case 'insertFromPaste':
            if (ie.data) send('type', { text: ie.data });
            break;
          case 'insertParagraph':
          case 'insertLineBreak':
            send('keypress', { key: 'Enter' });
            break;
          case 'deleteContentBackward':
            send('keypress', { key: 'Backspace' });
            break;
          case 'deleteContentForward':
            send('keypress', { key: 'Delete' });
            break;
        }
      };
      input.addEventListener('beforeinput', onBeforeInput);
      return () => input.removeEventListener('beforeinput', onBeforeInput);
    }, []);

    const onCompositionEnd = useCallback((e: React.CompositionEvent<HTMLInputElement>) => {
      e.stopPropagation();
      if (!suppressedRef.current && e.data) sendInput('type', { text: e.data });
      if (kbdRef.current) kbdRef.current.value = '';
    }, [sendInput]);

    // Keep the capture field empty so it never accumulates — and, quando il campo
    // remoto è una password, so che non ne resta traccia da nessuna parte.
    const onInput = useCallback(() => { if (kbdRef.current) kbdRef.current.value = ''; }, []);

    return (
      <input
        ref={kbdRef}
        type="text"
        data-testid="browser-dom-kbd"
        aria-hidden="true"
        tabIndex={-1}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        className="absolute left-0 top-0 z-0 opacity-0 pointer-events-none"
        style={{
          width: 1,
          height: 1,
          border: 0,
          padding: 0,
          caretColor: 'transparent',
          background: 'transparent',
          // 16px = la soglia sotto la quale iOS ingrandisce la pagina al focus.
          // È l'intera ragione per cui questa riga esiste: vedi CAPTURE_FONT_SIZE_PX.
          fontSize: `${CAPTURE_FONT_SIZE_PX}px`,
        }}
        onKeyDown={onKeyDown}
        onCompositionEnd={onCompositionEnd}
        onInput={onInput}
      />
    );
  },
);

export default BrowserKeyboardCapture;
