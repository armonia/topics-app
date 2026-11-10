/**
 * SARIM edition: the page after «Esci» in the menu of the person. The preview
 * has no accounts, so signing out keeps everything the reader changed and this
 * page is the way back in: «Rientra» goes to «Da fare». (allow-italian: quotes the Italian interface)
 */
import { LogOut } from 'lucide-react';
import type { AreaModule, ScreenDef } from '../../app/kit';
import { Button } from '../../../ui/primitives/Button';
import { SP } from '../paths';
import { world } from '../world';

const SCREENS: ScreenDef[] = [
  {
    id: 'sarim-signed-out',
    path: SP.signedOut(),
    org: world().key,
    nav: 'org',
    samples: [SP.signedOut()],
    transient: true,
    title: (_p, ctx) => ctx.copy.sarimShell.signedOut.title,
    render: (_p, ctx) => {
      const s = ctx.copy.sarimShell.signedOut;
      return (
        <div className="flex min-h-full flex-1 flex-col items-center justify-center gap-2 px-8 py-10 text-center">
          <span className="mb-1 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-black/[0.05] text-app-text-tertiary dark:bg-white/[0.08]">
            <LogOut size={18} aria-hidden="true" />
          </span>
          <h1 className="max-w-[440px] text-body-lg font-semibold text-app-text">{s.title}</h1>
          <p className="max-w-[440px] text-prose leading-6 text-app-text-secondary">{s.body}</p>
          <div className="mt-2">
            <Button variant="primary" onClick={() => ctx.go(SP.home())}>{s.back}</Button>
          </div>
        </div>
      );
    },
  },
];

export const SARIM_ACCOUNT_AREA: AreaModule = { screens: SCREENS };
