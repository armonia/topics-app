/**
 * THE SIGNALS OF THE BAR, under the names the sidebar has always imported.
 *
 * The tokens and their measurements live in `lib/statusVisual.ts`, the one
 * table of status colours: these are aliases, not copies, so the chrome and the
 * panes cannot drift apart again: the warning and the danger ink of this bar
 * and of `popoverStyles.ts` used to be the same string written twice.
 *
 * (The files panel, which sits on `--bg-elevated` and is therefore lighter, has
 * ITS own tuning in `lib/gitStatusColors.ts`, where the 700 ramp is enough.) */
import { STATUS_DOT, STATUS_INK } from '../../lib/statusVisual';

export const SEGNALE_OK = STATUS_INK.ok;
export const SEGNALE_ATTESA = STATUS_INK.wait;
export const SEGNALE_GUASTO = STATUS_INK.danger;
export const PALLINO_OK = STATUS_DOT.ok;
export const PALLINO_ATTESA = STATUS_DOT.wait;
