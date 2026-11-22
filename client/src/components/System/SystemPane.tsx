/**
 * SISTEMA: the one page for what the agents share. A column with Health,
 * Harness, Tools, Memories and Log, and the section on the right; each
 * section links to the agents it is about. The section is in the hash, so a
 * reload stays where it was. At phone width the column folds into a row on top.
 */
import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { addCatalogue } from '../../lib/i18n';
import SYSTEM_IT from '../../lib/i18n-system-it';
import SYSTEM_EN from '../../lib/i18n-system-en';
import { highestSeverity, useSystemHealth } from '../../state/systemHealth';
import { DANGER_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { SystemHealth } from './SystemHealth';
import { SystemHarness } from './SystemHarness';
import { SystemTools } from './SystemTools';
import { SystemMemories } from './SystemMemories';
import { SystemLog } from './SystemLog';
import { SYSTEM_SECTIONS, readSystemSection, systemSectionFromHash, writeSystemSection, type SystemSection } from './systemNav';

addCatalogue('it', SYSTEM_IT);
addCatalogue('en', SYSTEM_EN);

export function SystemPane() {
  const tr = useT();
  const [section, setSection] = useState<SystemSection>(() => readSystemSection());
  const { problems, reload } = useSystemHealth();
  useEffect(() => {
    const onHash = () => { const next = systemSectionFromHash(window.location.hash); if (next) setSection(next); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const go = (next: SystemSection) => { setSection(next); writeSystemSection(next); };
  const severity = problems ? highestSeverity(problems) : null;
  return (
    <div data-testid="system-pane" className="flex h-full min-h-0 flex-col overflow-hidden bg-app-surface md:flex-row">
      <nav aria-label={tr('system.title')} className="flex flex-shrink-0 flex-wrap gap-1 border-b border-app-border p-2 md:w-48 md:flex-col md:flex-nowrap md:border-b-0 md:border-r">
        <h1 className="hidden px-2 pb-1 text-compact font-semibold text-app-text md:block">{tr('system.title')}</h1>
        {SYSTEM_SECTIONS.map((id) => (
          <button
            key={id} type="button" data-testid={`system-nav-${id}`} aria-current={section === id ? 'page' : undefined}
            onClick={() => go(id)}
            className={`flex items-center gap-2 rounded px-2 py-1.5 text-left text-prose ${section === id ? 'bg-app-hover font-medium text-app-text' : 'text-app-text-secondary hover:bg-app-hover'}`}
          >
            <span className="min-w-0 flex-1 truncate">{tr(`system.nav.${id}`)}</span>
            {id === 'health' && problems && problems.length > 0 && (
              <span data-testid="system-nav-health-count" className={`text-mini tabular-nums ${severity === 'error' ? DANGER_TEXT : WARNING_TEXT}`}>{problems.length}</span>
            )}
          </button>
        ))}
      </nav>
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
        {section === 'health' && <SystemHealth problems={problems} reload={reload} />}
        {section === 'harness' && <SystemHarness />}
        {section === 'tools' && <SystemTools />}
        {section === 'memory' && <SystemMemories />}
        {section === 'log' && <SystemLog />}
      </main>
    </div>
  );
}
