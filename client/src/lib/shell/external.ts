// Opening a URL OUTSIDE the app, unified across Tauri / web. PORTING-PLAN.md §5b.
//
// WHY THIS IS ITS OWN MODULE and not part of `shell/app.ts`, where it used to
// live. `shell/app.ts` is the whole native bridge: lifecycle, dialogs, AND the
// notification banner, so it imports `notify/notifyTarget`, which in turn has to
// know how to open a deep-link. Anything that wanted "open this URL outside"
// therefore dragged in the entire notification stack, and once the deep-link
// front door started forwarding out of a detached window that closed a real
// import cycle (openExternal -> shell/app -> notifyTarget -> the front door).
// The capability itself depends on nothing but the host, so it belongs in a
// leaf: this file imports only `shellKind` and `tauriInvoke`, and can never be
// part of a cycle. See tests/unit/no-import-cycles.test.ts.

import { shellKind } from './index';
import { tauriInvoke } from './tauri';

/** Open a URL in the user's default browser (never inside the app shell). */
export async function openExternal(url: string): Promise<void> {
  switch (shellKind) {
    case 'tauri':
      // Native `open_external` command, NOT tauri-plugin-opener: the plugin's
      // open_url leaks a zombie process per call (it drops the spawned Child
      // without waiting). See the command's doc comment in src-tauri/src/lib.rs.
      await tauriInvoke('open_external', { url });
      return;
    default:
      window.open(url, '_blank', 'noopener,noreferrer');
  }
}
