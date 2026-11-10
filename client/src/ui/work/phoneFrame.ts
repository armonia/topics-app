/**
 * The height a screen gets inside the phone shell: the viewport minus the 48px
 * header and the 56px tab bar (and their safe areas). The shell's scroll area
 * does not hand a percentage height down in every engine, so a screen that
 * keeps a bar pinned under its own scroll region states the height itself.
 */
export const PHONE_FILL = 'h-[calc(100dvh-6.5rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))]';
