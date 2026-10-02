import { useState, useRef } from 'react';
import { X } from 'lucide-react';
import { MODAL_OVERLAY, MODAL_PANEL } from '../../lib/modalStyles';
import { AIProvidersSection } from './AIProvidersSection';
import { ToolsSection } from './ToolsSection';
import { CalendarSection } from './CalendarSection';
import { PlanSection } from './PlanSection';
import { NodesSection } from './NodesSection';
import { SETTINGS_SECTIONS, type SectionId } from './sections';
import { useModalDialog } from '../../hooks/useModalDialog';
import { useExitGhost } from '../../lib/exitGhost';
import { useT } from '../../hooks/useT';

interface GlobalSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  initialSection?: SectionId;
}

/**
 * THE SETTINGS PANEL: the forms, and nothing else (USERMENU-06).
 *
 * Five entries where something has to be typed: AI providers (keys, endpoints,
 * CLIs), tools (MCP servers, grants), calendar (a feed URL), plan (a token)
 * and nodes (an address and a code). The direct preferences are levels of the
 * user menu and who you are is the Profile tab, so nothing here is a copy of
 * something reachable elsewhere. It opens with ⌘, and from the last row of the
 * user menu, always as the window over the app: it is opened rarely, and ⌘,
 * is every Mac app's habit.
 *
 * Two tabs were removed long ago and must not come back: «Features» (one
 * switch that could only break the New Chat entry) and «Shortcuts» (a third
 * hand-written copy of `shared/shortcuts.ts`, and a wrong one).
 */
export function GlobalSettings({ isOpen, onClose, initialSection }: GlobalSettingsProps) {
  const t = useT();
  // App mounts the panel only while it is open, so the section asked for is
  // read on every open by the initial state alone.
  const [section, setSection] = useState<SectionId>(initialSection ?? 'providers');
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes, Tab stays inside, focus returns to whoever opened it.
  useModalDialog({ open: isOpen, onClose, panelRef });

  // The veil and the panel leave together, over the panel's own 150ms.
  const overlayRef = useRef<HTMLDivElement>(null);
  useExitGhost(overlayRef, isOpen, 'modal');

  if (!isOpen) return null;

  return (
    <div ref={overlayRef} className={MODAL_OVERLAY} onClick={onClose}>
      <div
        ref={panelRef}
        data-testid="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        // TWO SHAPES around `md:` (768px). From 768 up, the 760px window with
        // the navigation column on the left; below, a full-screen sheet with
        // the navigation as a scrolling row on top, so the whole width goes to
        // the content. `100dvh`, not `100vh`: on iOS `vh` counts the window
        // without the address bar. `max-md:rounded-none` and not
        // `rounded-none`, so it does not fight `rounded-xl` of `MODAL_PANEL`.
        className={`flex w-full flex-col ${MODAL_PANEL} h-[100dvh] max-h-none max-md:rounded-none md:mx-4 md:h-[80vh] md:max-h-[640px] md:max-w-[760px]`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex flex-shrink-0 items-center justify-between border-b border-app-border px-5 py-3"
          // The notch: the sheet starts at `inset-0`.
          style={{ paddingTop: 'max(env(safe-area-inset-top, 0px), 0.75rem)' }}
        >
          <h2 id="settings-title" className="text-title font-semibold text-app-text">{t('settings.title')}</h2>
          {/* 44px under a finger: full screen, there is no veil left to tap. */}
          <button aria-label={t('settings.close')}
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded text-app-text-tertiary transition-colors hover:bg-black/5 hover:text-app-text-secondary coarse:h-11 coarse:w-11 dark:hover:bg-white/5"
          >
            <X size={14} className="coarse:h-5 coarse:w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* Sidebar (desktop) / riga di schede scorrevole (mobile) */}
          <nav className="flex flex-shrink-0 gap-1 overflow-x-auto overscroll-x-contain border-b border-app-border bg-app-hover/30 px-2 py-2 md:w-[180px] md:flex-col md:gap-0.5 md:overflow-x-visible md:border-b-0 md:border-r md:py-3">
            {SETTINGS_SECTIONS.map(({ id, labelKey, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setSection(id)}
                // `whitespace-nowrap` + `flex-shrink-0`: in riga le etichette
                // non devono andare a capo né stringersi, altrimenti la riga
                // smette di scorrere e comincia a impilarsi.
                // `min-h-11` sotto il dito = i 44px della soglia.
                className={`flex flex-shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-left text-prose transition-colors coarse:min-h-11 md:w-full md:px-2.5 ${
                  section === id
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-app-text-secondary hover:bg-app-hover hover:text-app-text'
                }`}
                aria-current={section === id ? 'page' : undefined}
              >
                <Icon size={14} className="flex-shrink-0" />
                {t(labelKey)}
              </button>
            ))}
          </nav>

          {/* Content */}
          {/* `min-w-0`: senza, un figlio incomprimibile (una riga lunga, una
              tabella) allarga la colonna oltre il pannello e si porta dietro
              una barra di scorrimento ORIZZONTALE — che a 390px era il difetto
              visibile. Il padding di fondo tiene conto della barra gesti. */}
          <div
            className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 md:px-5"
            style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 1rem)' }}
          >
            {section === 'providers' && <AIProvidersSection />}
            {section === 'tools' && <ToolsSection />}
            {section === 'calendar' && <CalendarSection />}
            {section === 'plan' && <PlanSection />}
            {section === 'nodes' && <NodesSection />}
          </div>
        </div>
      </div>
    </div>
  );
}
