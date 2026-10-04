/** Shared chat and task composer styles, without importing either component. */
/** An icon button of a composer row: 32 with the mouse, 44 under a finger
 *  (it was 32 on the phone too, usability audit 04/10). The glyph does not
 *  change, the box around it does. */
export const COMPOSER_ICON_BUTTON = 'w-8 h-8 coarse:w-11 coarse:h-11';

export const COMPOSER_CARD =
  'rounded-2xl shadow-md border border-app-border-light focus-within:border-primary bg-surface transition-[border-color]';

/** The host keeps its existing mobile/desktop font-size choice.
 *  `coarse:py-3`: under a finger the field is 44 tall like the buttons beside
 *  it (it was 32, usability audit 04/10), and the line stays centred. */
export const COMPOSER_TEXTAREA =
  'flex-1 min-w-[4rem] px-1.5 py-1.5 coarse:py-3 leading-5 bg-transparent text-app-text placeholder-app-placeholder resize-none overflow-y-auto focus:outline-none focus-visible:outline-none';
