/**
 * THE ROWS OF SYSTEM THAT EXIST ONLY WITH THE USAGE HUB (hub-smistamento):
 * the agents' context (a level, HUBBR-17), the processes (the machine's view,
 * HUBBR-04) and the feature map (a view, HUBBR-18), in the
 * order of the approved mockup.
 *
 * A chunk of their own, loaded by System only where the hub has answered: the
 * menu is on the app's first download and these rows, their tails and their
 * strings are not. Each tail is a number out of the document its row opens
 * (`state/hubDocs`), so the level or the view finds it already read.
 */
import { lazy, Suspense } from 'react';
import { Blocks, Layers, MonitorCog } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { addCatalogue } from '../../lib/i18n';
import HUB_CONTEXT_IT from '../../lib/i18n-hub-context-it';
import HUB_CONTEXT_EN from '../../lib/i18n-hub-context-en';
import { contextView, shortTokens } from '../../lib/hubContext';
import { HUB_CONTEXT_DOC, HUB_FEATURES_DOC, useHubDoc } from '../../state/hubDocs';
import { SubmenuItem } from '../Shared/SubmenuItem';
import { menuRowClass } from './menuRow';

addCatalogue('it', HUB_CONTEXT_IT);
addCatalogue('en', HUB_CONTEXT_EN);

const ContextLevel = lazy(async () => {
  const { ContextLevel: Body } = await import('./ContextLevel');
  return { default: Body };
});

/** The map changes once a day: reopening System within ten minutes reads nothing. */
const FEATURES_MAX_AGE_MS = 10 * 60_000;

function openUtility(type: 'processes' | 'features', onNavigate?: () => void) {
  onNavigate?.();
  window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type } }));
}

/** How many features Jarvis is behind on, straight from the map's totals. */
function behindOf(data: unknown): number | null {
  const totals = typeof data === 'object' && data !== null ? (data as { totals?: { behind?: unknown } }).totals : undefined;
  return typeof totals?.behind === 'number' ? totals.behind : null;
}

export interface HubSystemRowsProps {
  isMobile: boolean;
  onNavigate?: () => void;
}

export function HubSystemRows({ isMobile, onNavigate }: HubSystemRowsProps) {
  const tr = useT();
  const locale = useLocale();
  const context = useHubDoc(HUB_CONTEXT_DOC, true, 60_000);
  const features = useHubDoc(HUB_FEATURES_DOC, true, FEATURES_MAX_AGE_MS);
  const base = contextView(context.data)?.claudeCode ?? null;
  const behind = behindOf(features.data);
  const tail = 'flex-shrink-0 text-app-text-secondary tabular-nums';
  return (
    <>
      <SubmenuItem
        icon={Layers}
        label={tr('hubContext.open')}
        testId="menu-system-context"
        minWidth={400}
        maxWidth={420}
        className={isMobile ? 'min-h-[calc(100dvh-3rem)]' : 'max-h-[min(80vh,640px)] overflow-y-auto'}
        tail={base !== null ? <span data-testid="menu-system-context-tail" className={tail}>{tr('hubContext.tail', { n: shortTokens(base, locale) })}</span> : undefined}
      >
        <Suspense fallback={<div className="min-h-24 px-3 py-2 text-mini text-app-text-muted">{tr('hubContext.reading')}</div>}>
          <ContextLevel onNavigate={onNavigate} />
        </Suspense>
      </SubmenuItem>
      <button type="button" className={menuRowClass(isMobile)} data-testid="menu-system-processes" onClick={() => openUtility('processes', onNavigate)}>
        <MonitorCog size={14} className="flex-shrink-0 text-app-text-secondary" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-left">{tr('processes.open')}</span>
      </button>
      <button type="button" className={menuRowClass(isMobile)} data-testid="menu-system-features" onClick={() => openUtility('features', onNavigate)}>
        <Blocks size={14} className="flex-shrink-0 text-app-text-secondary" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-left">{tr('features.open')}</span>
        {behind !== null && <span data-testid="menu-system-features-tail" className={tail}>{tr('hubContext.featuresTail', { n: behind })}</span>}
      </button>
    </>
  );
}
