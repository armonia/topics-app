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

/**
 * Combined container + backdrop, for modals whose outermost element is BOTH the
 * full-screen flex centerer AND the dimming layer (e.g. GlobalSettings, the
 * Agent dialogs). Append your own justify/items overrides if you don't want
 * dead-center.
 */
export const MODAL_OVERLAY =
  'fixed inset-0 z-50 flex items-center justify-center bg-black/30 dark:bg-black/50 backdrop-blur-sm';

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
 */
export const MODAL_PANEL =
  'bg-surface rounded-xl shadow-2xl border border-app-border overflow-hidden command-palette-enter';
