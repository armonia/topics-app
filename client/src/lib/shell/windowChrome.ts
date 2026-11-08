/**
 * WHICH WINDOW CHROME THIS PAGE IS RUNNING UNDER, as one value.
 *
 * Three surfaces have to make room for the window commands, and they used to
 * ask three different questions: the title inset asked `isTauriMac ||
 * isTauriWindows`, the traffic-light box has to ask "is it the Mac", and the
 * content top bar has to ask the same again when the sidebar is collapsed.
 * Three questions drift; one value cannot. `windowChrome` is that value, and
 * everything that needs to know reads it (`windowControlsGeometry.ts` for the
 * numbers, `App.tsx` and `StandaloneChatGroup.tsx` for the room).
 *
 * `isTauriWindows` keeps its meaning and its callers: it says whether the app
 * must DRAW its own commands (`WindowControls.tsx`). This value says which
 * geometry the row must reserve, which is a different question with an
 * overlapping answer.
 *
 * THE OVERRIDE. `?windowChrome=mac|windows|none` on the page URL wins over the
 * detection. It exists for one reason only: the chrome geometry has to be
 * MEASURABLE from a normal browser, where there is no Tauri shell and no
 * native lights. An e2e spec loads the app with `?windowChrome=mac`, measures
 * the box the sidebar reserves and the inset the content keeps, and those
 * numbers are the proof. Nothing in the product sets this parameter.
 */
import { isTauri, isTauriWindows } from './index';

export type WindowChrome = 'mac' | 'windows' | 'none';

const OVERRIDE_PARAM = 'windowChrome';

/**
 * Pure: the decision, given what the page knows. Exported so a unit test can
 * exercise each branch without faking `location` before the module loads.
 */
export function resolveWindowChrome(opts: {
  search: string;
  tauri: boolean;
  tauriWindows: boolean;
  platform: string;
}): WindowChrome {
  const forced = new URLSearchParams(opts.search).get(OVERRIDE_PARAM);
  if (forced === 'mac' || forced === 'windows' || forced === 'none') return forced;
  if (!opts.tauri) return 'none';
  if (opts.tauriWindows) return 'windows';
  if (/Mac/i.test(opts.platform)) return 'mac';
  return 'none';
}

export const windowChrome: WindowChrome = resolveWindowChrome({
  search: typeof location !== 'undefined' ? location.search : '',
  tauri: isTauri,
  tauriWindows: isTauriWindows,
  platform: typeof navigator !== 'undefined' ? navigator.platform || '' : '',
});
