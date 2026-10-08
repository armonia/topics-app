/**
 * What every view kind but `compare` shares: the title, the line under it, the
 * verdict, and a link that opens like every other link in a chat. `compare`
 * keeps its own copy because its test ids predate this file.
 */
import type { MouseEvent, ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { openLink, isExternalLinkGesture } from '../../lib/openLink';

export type ViewVariant = 'chat' | 'page';

export function ViewHeader({ kind, title, subtitle, verdict, variant }: {
  kind: string; title: string; subtitle?: string; verdict?: string; variant: ViewVariant;
}) {
  const tr = useT();
  const page = variant === 'page';
  return (
    <>
      <header className={page ? 'mb-4' : 'mb-2'}>
        <h2 data-testid={`${kind}-title`} className={`${page ? 'text-headline' : 'text-title'} font-semibold leading-tight text-app-text-heading`}>
          {title}
        </h2>
        {subtitle && <p className="mt-0.5 text-compact text-app-text-secondary">{subtitle}</p>}
      </header>
      {verdict && (
        <p data-testid={`${kind}-verdict`} className={`${page ? 'mb-4 text-body-lg' : 'mb-3 text-prose'} rounded border border-app-border bg-app-inset px-3 py-2 text-app-text`}>
          <span className="mr-1.5 font-semibold text-app-text-heading">{tr('views.verdict')}:</span>
          {verdict}
        </p>
      )}
    </>
  );
}

/** A link of the view's data: a Topics browser tab in the chat, the plain browser on the page. */
export function ViewLink({ url, variant, testId, className, children }: {
  url: string; variant: ViewVariant; testId: string; className: string; children: ReactNode;
}) {
  return (
    <a
      data-testid={testId}
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        if (variant === 'page') return;
        e.preventDefault();
        openLink(url, { external: isExternalLinkGesture(e), origin: e.target });
      }}
      className={className}
    >
      {children}
      <ArrowUpRight size={12} aria-hidden />
    </a>
  );
}
