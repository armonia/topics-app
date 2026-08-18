/**
 * modalStyles — ONE canonical look for every modal / dialog / floating window,
 * derived from the ⌘K command palette (the reference surface the rest of the
 * app aligns to). Before this module each dialog hand-rolled its own backdrop
 * opacity (/30, /40, /50, /60), border token (app-border vs app-border-light),
 * radius (rounded-lg vs rounded-xl) and shadow (shadow-xl vs shadow-2xl), so
 * they read as visibly different surfaces. Importing from here keeps them in
 * lockstep — the same precedent as lib/selectionStyles.ts for selection.
 *
 * Translucency: the backdrop is semi-transparent black + a light `backdrop-blur`
 * so the modal frosts the content behind it (matching the app's macOS-vibrancy
 * aesthetic). The panel itself keeps the OPAQUE `bg-surface` — exactly like the
 * command palette — so dense text in dialogs stays crisp and readable.
 */
import { Z_MODAL } from './popoverStyles';

/**
 * Il piano dei modali, come classe Tailwind. Gemello di `Z_MODAL` in
 * `lib/popoverStyles.ts` (10000) — i due DEVONO restare allineati: un modale a
 * `z-50` finiva sotto ogni popover (9999) e un dropdown rimasto aperto si
 * disegnava sopra il velo. Nessuna superficie modale scrive più il numero a
 * mano: si importa questa, o `Z_MODAL` se serve come valore inline.
 *
 * «DEVONO restare allineati» era una FRASE, non un vincolo: il numero stava
 * scritto a mano qui (due volte, contando `MODAL_OVERLAY`) e come costante là,
 * e niente si accorgeva se divergevano. Ora l'annotazione lo lega a `Z_MODAL`:
 * cambiare la costante cambia il TIPO di questa riga, e la stringa scritta
 * sotto smette di compilare finché non la si aggiorna.
 *
 * Un'annotazione, e non una classe composta a runtime dal valore: Tailwind
 * cerca le classi come TESTO nei sorgenti, quindi interpolare la costante non
 * genererebbe nessuna regola e il piano dei modali smetterebbe di esistere in
 * silenzio. La stringa resta letterale — è il tipo a fare da cancello.
 */
export const MODAL_LAYER: `z-[${typeof Z_MODAL}]` = 'z-[10000]';

/**
 * Combined container + backdrop, for modals whose outermost element is BOTH the
 * full-screen flex centerer AND the dimming layer (e.g. GlobalSettings, the
 * Agent dialogs). Append your own justify/items overrides if you don't want
 * dead-center.
 */
export const MODAL_OVERLAY =
  `fixed inset-0 ${MODAL_LAYER} flex items-center justify-center bg-black/30 dark:bg-black/50 backdrop-blur-sm`;

/**
 * Standalone backdrop layer, for modals that render the dimming div separately
 * from the flex container (e.g. CommandPalette, NewTopicModal, TopicSettingsModal).
 */
export const MODAL_BACKDROP = 'fixed inset-0 bg-black/30 dark:bg-black/50 backdrop-blur-sm';

/**
 * The panel container (the actual card). Opaque surface, soft 12px radius, large
 * shadow, hairline border, clipped corners, and the shared fade/slide-in
 * entrance animation (`command-palette-enter`, defined in index.css). Add sizing
 * (max-w-*, w-*, max-h-*) and layout (flex flex-col) per dialog.
 *
 * `native-occlude` is a no-op marker class (no style — see OVERLAY_SELECTOR in
 * lib/shell/browserOcclusion). Because every full-screen dialog composes its card
 * from MODAL_PANEL, this makes the Tauri native browser pane freeze-frame under
 * ANY modal automatically — no per-modal `role="dialog"` to remember. A native
 * WKWebView composites above the DOM, so without this the modal would render
 * UNDER the browser pane.
 */
export const MODAL_PANEL =
  'native-occlude bg-surface rounded-xl shadow-2xl border border-app-border overflow-hidden command-palette-enter';

/**
 * La variante MOBILE delle superfici di ricerca: una PAGINA, non una scheda che
 * galleggia. Sotto i 768px una scheda centrata e' il peggio dei due mondi. Il
 * `pt-[12vh]` della palette e il `pt-[10vh]` di FileSearch regalavano un decimo
 * di schermo al velo proprio dove lo schermo non c'e', il `max-h` tagliava la
 * lista a due terzi, e con la tastiera software aperta restavano poche righe
 * visibili. A schermo pieno la lista prende tutto quello che c'e'.
 *
 * Niente raggio, niente ombra, niente bordo: una pagina non ha spigoli da
 * mostrare, li ha lo schermo. Resta `native-occlude`, perche' la ragione per cui
 * c'e' non cambia con la larghezza: sotto una superficie modale la pane nativa
 * del browser Tauri deve congelarsi, altrimenti una WKWebView si compone SOPRA
 * il DOM e la pagina di ricerca finisce sotto.
 *
 * `command-palette-enter` resta anche qui: l'entrata e' la stessa, cambia la
 * geometria.
 */
export const MODAL_PAGE_CONTAINER = `fixed inset-0 ${MODAL_LAYER} flex flex-col`;

/** Il corpo della pagina a schermo pieno. Gemello mobile di `MODAL_PANEL`. */
export const MODAL_PAGE_PANEL =
  'native-occlude bg-surface overflow-hidden command-palette-enter flex flex-col flex-1 min-h-0';

/**
 * Una pagina a schermo pieno scavalla la tacca: il contenitore e' `fixed inset-0`,
 * quindi parte da y=0 e nessun padding di pagina la protegge. Va sul CORPO della
 * pagina, cosi' la striscia sotto la tacca la dipinge la sua stessa superficie.
 * `--sat` (index.css) vale 0 dove la tacca non c'e', quindi si applica sempre e
 * non serve chiedersi se il dispositivo ne ha una.
 */
export const MODAL_PAGE_INSET = { paddingTop: 'var(--sat, 0px)' } as const;
