// GroupsSection — i GRUPPI nella sidebar.
//
// Un gruppo è l'unità: un insieme di tab che vivi insieme. Una finestra non è
// un concetto a parte — è un gruppo STACCATO, che è esattamente perché la
// vecchia sezione "Finestre" è sparita da qui: elencava lo stesso materiale con
// un nome diverso, e teneva in vita un secondo modello mentale per la stessa
// cosa.
//
// Il gruppo È lo Spazio del pane-store (`Pane.spaceId` + il registro
// `state.spaces`), l'unico dei tre candidati che sia davvero un contenitore:
// ha identità e nome sincronizzati, membership per-pane con LWW, geometria
// della griglia per gruppo, e un cap. Il `group:default` del pane-store non lo
// è: ne esiste uno solo, nessun renderer lo itera, e `splitRatio`/`splitAxis`
// non li legge nessuno — è la lista ordinata delle tab a livello app, e resta
// tale (è la fonte dell'ordine qui sotto).
//
// Cosa mostra una riga:
//   - il nome del gruppo, il numero di tab, e le tab stesse con l'icona del
//     tipo (chat, terminale, progetto, browser, …) — TUTTE, non solo le chat;
//   - un click sul nome COMMUTA il gruppo (SET_ACTIVE_SPACE), che è la stessa
//     azione dei chip della striscia in alto;
//   - una tab tenuta da un'ALTRA finestra porta il glifo della finestra e ci
//     porta sopra, che è la sola cosa che la sezione "Finestre" sapeva fare e
//     che qui non si perde.
//
// Zero chrome finché non c'è niente da distinguere: con il solo gruppo
// implicito la sezione non si disegna (stessa regola dello SpaceSwitcher).
import { useMemo, useState } from 'react';
import {
  AppWindow, BarChart3, ChevronDown, ChevronRight, Clock, Cpu, FolderOpen,
  Globe, Kanban, Layers, LayoutGrid, MessageSquare, TerminalSquare, type LucideIcon,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { focusOrReopenDetachedWindow } from '@/lib/detachedWindow';
import { useOtherWindows, windowTabs } from '@/state/windowPresence';
import { usePaneStore } from '@/state/pane/store';
import { resolvePaneSpace } from '@/state/pane/reducers/spaces';
import { getPaneConfig } from '@/state/pane/adapters/paneConfig';
import { DEFAULT_SPACE_ID, type PaneType } from '@/state/pane/types';
import { DEFAULT_SPACE_LABEL, liveSpacesOrdered, isDetachedWindow } from '@/components/Layout/spaceHelpers';
import { SELECTED_SURFACE } from '@/lib/selectionStyles';
import type { Topic } from '@/types';

interface GroupsSectionProps {
  topics: Record<string, Topic>;
  /** Focus a tab BY PANE ID (usePanelLifecycle's handleFocusPanel). Not the
   *  topic funnel: these rows carry projects and terminals too, and that funnel
   *  would register `project:%2Fsrv%2Facme` as a chat. */
  onFocusTab: (paneId: string) => void;
  /** Reopen a topic here when the window holding it can't be raised. */
  onReopenTopic: (topicId: string) => void;
}

/** Un glifo per tipo di pane, così una riga si legge senza aprirla. */
const TAB_ICONS: Record<string, LucideIcon> = {
  chat: MessageSquare,
  terminal: TerminalSquare,
  'process-log': TerminalSquare,
  browser: Globe,
  project: FolderOpen,
  files: FolderOpen,
  kanban: Kanban,
  board: Kanban,
  dashboard: BarChart3,
  agents: Cpu,
  cron: Clock,
};

/** Separatore dello snapshot: un carattere di controllo che nessun titolo
 *  contiene, così encode/decode è totale. */
const SEP = '';

interface GroupTab {
  id: string;
  type: string;
  title?: string;
  spaceId: string;
}

/** Il nome da mostrare: quello del topic per una chat, il titolo della tab
 *  altrimenti, e l'etichetta del tipo quando non c'è né l'uno né l'altro. */
function tabLabel(tab: GroupTab, topics: Record<string, Topic>): string {
  const topic = topics[tab.id];
  if (topic) return topic.name || topic.icon || tab.id;
  if (tab.title) return tab.title;
  return tab.type === 'chat' ? tab.id : getPaneConfig(tab.type as PaneType).label;
}

export function GroupsSection({ topics, onFocusTab, onReopenTopic }: GroupsSectionProps) {
  const dispatch = usePaneStore((s) => s.dispatch);
  const activeSpaceId = usePaneStore((s) => s.activeSpaceId);
  const spaces = usePaneStore((s) => s.spaces);
  const others = useOtherWindows();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Le tab a livello app, nell'ordine di `group:default`, con il loro gruppo
  // risolto. Codificate come STRINGHE piatte e decodificate sotto: iscriversi a
  // `s.panes` ridisegnerebbe questa sezione a ogni scrittura di pane —
  // `setPaneScrollOffset` ne fa una ogni 250ms mentre scorri una chat — perché
  // Immer restituisce un'identità nuova ogni volta.
  const encoded = usePaneStore(
    useShallow((s) => (s.groups['group:default']?.paneIds ?? []).map((id) => {
      const p = s.panes[id];
      return [id, p?.type ?? 'chat', resolvePaneSpace(p, s.spaces), p?.title ?? ''].join(SEP);
    })),
  );
  const tabs = useMemo<GroupTab[]>(
    () => encoded.map((enc) => {
      const [id, type, spaceId, ...rest] = enc.split(SEP);
      const title = rest.join(SEP);
      return { id, type, spaceId, ...(title ? { title } : {}) };
    }),
    [encoded],
  );

  // paneId → la finestra che ce l'ha, quando non è questa. È quello che la
  // sezione "Finestre" sapeva fare, espresso per TAB invece che per finestra:
  // finché staccare non porta con sé il gruppo, l'attribuzione esatta è questa.
  const elsewhere = useMemo(() => {
    const map = new Map<string, { label: string; win: (typeof others)[number] }>();
    for (const w of others) {
      const name = w.detached ? 'un\'altra finestra' : 'la finestra principale';
      for (const t of windowTabs(w)) if (!map.has(t.id)) map.set(t.id, { label: name, win: w });
    }
    return map;
  }, [others]);

  const ordered = useMemo(() => liveSpacesOrdered(spaces), [spaces]);

  // Un pop-out salta ogni bridge del pane-store: qui non c'è niente da mostrare.
  if (isDetachedWindow()) return null;
  // Un solo gruppo implicito e nessuna tab altrove = niente da distinguere:
  // l'albero qui sotto elenca già quelle tab, e una sezione con una riga sola
  // sarebbe rumore. La seconda metà della condizione è ciò che impedisce a
  // questa sezione di perdere l'unica cosa che "Finestre" faceva davvero: se
  // una tab vive in un'altra finestra la sezione si accende comunque, anche
  // senza che tu abbia mai creato un gruppo.
  if (ordered.length === 0 && elsewhere.size === 0) return null;

  const rows = [
    { id: DEFAULT_SPACE_ID, name: DEFAULT_SPACE_LABEL },
    ...ordered.map((s) => ({ id: s.id, name: s.name || 'Gruppo' })),
  ];

  return (
    <div className="px-2 pt-2 pb-1" data-testid="sidebar-groups">
      <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-app-text-tertiary">
        Gruppi
      </div>
      <div className="flex flex-col gap-0.5">
        {rows.map((row) => {
          const isCollapsed = collapsed[row.id] ?? false;
          const members = tabs.filter((t) => t.spaceId === row.id);
          const isActive = row.id === activeSpaceId;
          return (
            <div key={row.id}>
              <div
                className={`group flex w-full items-center gap-1 rounded-md px-1 text-[13px] transition-colors ${
                  isActive ? `${SELECTED_SURFACE} text-app-text` : 'text-app-text hover:bg-app-hover'
                }`}
              >
                <button
                  onClick={() => setCollapsed((c) => ({ ...c, [row.id]: !isCollapsed }))}
                  className="flex-shrink-0 py-1.5 pl-0.5 text-app-text-tertiary"
                  aria-expanded={!isCollapsed}
                  aria-label={isCollapsed ? `Espandi ${row.name}` : `Comprimi ${row.name}`}
                >
                  {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                </button>
                <button
                  onClick={() => {
                    if (!isActive) dispatch({ type: 'SET_ACTIVE_SPACE', payload: { id: row.id } });
                  }}
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
                  data-testid="group-row"
                  data-space-id={row.id}
                  aria-current={isActive ? 'true' : undefined}
                  title={`${members.length} ${members.length === 1 ? 'scheda' : 'schede'} · vai al gruppo`}
                >
                  <Layers size={13} className="flex-shrink-0 text-app-text-tertiary" />
                  <span className="min-w-0 flex-1 truncate">{row.name}</span>
                  <span className="flex-shrink-0 pr-1 text-[11px] tabular-nums text-app-text-tertiary">
                    {members.length}
                  </span>
                </button>
              </div>
              {!isCollapsed && (
                <div className="flex flex-col">
                  {members.map((tab) => {
                    const TabIcon = TAB_ICONS[tab.type] ?? LayoutGrid;
                    const away = elsewhere.get(tab.id);
                    return (
                      <button
                        key={tab.id}
                        onClick={() => {
                          if (away) focusOrReopenDetachedWindow(away.win, onReopenTopic);
                          else onFocusTab(tab.id);
                        }}
                        className="flex w-full items-center gap-2 rounded-md py-1 pl-6 pr-2 text-left text-[12px] text-app-text-secondary transition-colors hover:bg-app-hover hover:text-app-text"
                        data-testid="group-tab"
                        data-pane-type={tab.type}
                        title={away ? `Aperta in ${away.label}` : undefined}
                      >
                        <TabIcon size={12} className="flex-shrink-0 text-app-text-tertiary" />
                        <span className="min-w-0 flex-1 truncate">{tabLabel(tab, topics)}</span>
                        {away && (
                          <AppWindow
                            size={11}
                            className="flex-shrink-0 text-app-text-tertiary"
                            aria-label={`Aperta in ${away.label}`}
                            data-testid="tab-elsewhere"
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 border-b border-app-border" />
    </div>
  );
}
