/**
 * THE SHAPE OF A ROW in the menus of the chrome, in one place.
 *
 * The commands of the column, the sections of the profile menu and the system
 * rows are three files and one list: the user reads them stacked, in a single
 * popover, so a padding written three times is three lists that drift apart at
 * the first tidy-up. The two sizes are the finger and the mouse, and the
 * predicate is passed in rather than measured here - a `md:` breakpoint inside
 * a row would be a second mechanism deciding what the host already decided.
 */
export function menuRowClass(isMobile: boolean): string {
  return 'w-full flex items-center gap-2.5 px-3 text-app-text hover:bg-app-hover transition-colors '
    + (isMobile ? 'py-3 min-h-11 text-[14px]' : 'py-1.5 text-[12px] coarse:py-3 coarse:text-[14px]');
}
