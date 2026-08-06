/**
 * addMenuItems — l'ELENCO delle cose che si possono creare, in un posto solo.
 *
 * Prima esisteva due volte: le righe del menu "+" (`PaneAddMenu`) e le pill
 * "New" della palette ⌘K (`CommandPalette`), scritte a mano separatamente. Le
 * due liste erano già divergenti — ⌘K non offriva opencode, né Browser, né
 * Board — e i quattro agenti del terminale erano cablati a mano in entrambe,
 * benché `shared/terminal-session-types.ts` dichiari di essere il registro
 * («Chi genera un menu di creazione usa `TERMINAL_AGENT_TYPES`»). Aggiungere un
 * agente costava tre modifiche e se ne dimenticava sempre una.
 *
 * Qui c'è il MODELLO (id, etichetta, lettera, icona, azione); la resa resta di
 * chi disegna — righe nel menu, pill nella palette.
 */
import {
  MessageSquare, TerminalSquare, Globe, GitBranch, Activity, BookOpen, Cpu, Kanban,
  BarChart3, LayoutGrid, FolderOpen, FolderPlus, FolderTree, FileCode, Eye, Terminal,
  Brain, type LucideIcon,
} from 'lucide-react';
import { ClaudeIcon } from './ClaudeIcon';
import { CodexIcon } from './CodexIcon';
import { getPaneConfig, getAddableTypesForScope, type PaneScope } from '../../state/pane/adapters';
import { ADD_MENU_MNEMONICS, type AddMenuItemId } from '../../state/pane/adapters/paneMnemonics';
import { TERMINAL_AGENT_TYPES, type TerminalAgentType } from '../../../../shared/terminal-session-types';
import { TERMINAL_AGENT_LABELS } from '../../lib/terminalAgents';
import type { PaneType } from '../../types';

/** Lookup `PaneConfig.icon` → componente lucide. Da tenere allineata ai nomi in
 *  `PANE_CONFIG`; un nome non mappato non disegna icona (e non rompe niente). */
const ICON_MAP: Record<string, LucideIcon> = {
  MessageSquare, Terminal, TerminalSquare, Globe, GitBranch, FolderTree, FolderOpen,
  FileCode, Activity, BookOpen, Cpu, Kanban, Brain, BarChart3, LayoutGrid, Eye,
};

/** Come si dipinge ogni agente del terminale. `Record<TerminalAgentType, …>`
 *  apposta: aggiungere un agente al registro condiviso NON compila finché non
 *  gli si è dato un volto qui — che è esattamente il controllo che mancava. */
const TERMINAL_AGENT_PRESENTATION: Record<
  TerminalAgentType,
  { icon: 'terminal' | 'claude' | 'codex' | 'cpu'; color?: string }
> = {
  // Viola dalla palette di PANE_CONFIG.terminal: Shell e Claude Code sono
  // entrambe sessioni pty e devono leggersi come la stessa famiglia.
  shell: { icon: 'terminal' },
  'claude-code': { icon: 'claude', color: '#D97757' },
  // Mono di proposito: il marchio OpenAI è monocromatico (vedi CodexIcon).
  codex: { icon: 'codex' },
  // opencode → Cerebras GLM-4.7. Teal della dashboard di ripiego; la Cpu
  // ammicca al silicio Cerebras.
  opencode: { icon: 'cpu', color: '#0f8f80' },
};

/** Tre membri distinti e non `{kind:'claude'|'codex'}`: TypeScript non sa
 *  sottrarre una literal da un discriminante a sua volta unione, quindi il
 *  ramo lucide non si restringerebbe mai. */
export type AddMenuIconSpec =
  | { kind: 'lucide'; Component: LucideIcon | null; color?: string }
  | { kind: 'claude' }
  | { kind: 'codex' };

export interface AddMenuItem {
  id: AddMenuItemId;
  label: string;
  /** Lettera da premere NUDA a menu aperto. Vedi `paneMnemonics.ts`. */
  mnemonic: string;
  /** `data-testid` della riga — contratto per le spec E2E, da non cambiare. */
  testId: string;
  run: () => void;
  /** Separatore PRIMA di questa riga (le voci di progetto aprono una finestra
   *  intera, non una pane: vanno staccate). */
  dividerBefore?: boolean;
  /** Come dipingere l'icona. */
  icon: AddMenuIconSpec;
}

export interface BuildAddMenuItemsArgs {
  scope: PaneScope;
  /** Filtro sui singleton già presenti nel gruppo. MAI un riordino: l'ordine e
   *  l'insieme sono dello scope. */
  availableTypes?: readonly PaneType[];
  onNewChat?: () => void;
  onAddPane?: (type: PaneType, subType?: string) => void;
  /** Apri/Crea Progetto — solo standalone e solo su desktop (serve il dialog OS). */
  onProjectPicker?: () => void;
}

/** Ordine curato. `getAddableTypesForScope` restituisce i tipi nell'ordine di
 *  PANE_CONFIG, che va bene per il codice e male per il menu: mette le voci
 *  rare (Files, Board) sopra quelle frequenti (Shell, Claude Code). I tipi non
 *  elencati finiscono in coda nel loro ordine dichiarato, così aggiungere un
 *  `addableScopes` continua a bastare per farli comparire. */
const CURATED_ORDER: PaneType[] = ['terminal', 'browser', 'git', 'files'];

function iconFor(paneType: PaneType) {
  const cfg = getPaneConfig(paneType);
  return { kind: 'lucide' as const, Component: ICON_MAP[cfg.icon] ?? null, color: cfg.color };
}

export function buildAddMenuItems({
  scope,
  availableTypes,
  onNewChat,
  onAddPane,
  onProjectPicker,
}: BuildAddMenuItemsArgs): AddMenuItem[] {
  const items: AddMenuItem[] = [];

  if (onNewChat) {
    items.push({
      id: 'new-chat',
      label: 'New Chat',
      mnemonic: ADD_MENU_MNEMONICS['new-chat'],
      testId: 'pane-add-menu-new-chat',
      run: onNewChat,
      // Tinta di marca della pane chat (PANE_CONFIG.chat.color): senza, New Chat
      // restava l'unica riga a inchiostro neutro e il menu sembrava a metà.
      icon: { kind: 'lucide', Component: MessageSquare, color: getPaneConfig('chat').color },
    });
  }

  if (onAddPane) {
    const scopeTypes = availableTypes ?? getAddableTypesForScope(scope);
    const ordered = [
      ...CURATED_ORDER.filter((t) => scopeTypes.includes(t)),
      ...scopeTypes.filter((t) => !CURATED_ORDER.includes(t)),
    ];
    for (const type of ordered) {
      if (type === 'terminal') {
        // Gli agenti vengono dal registro condiviso, non da una lista scritta
        // qui: è l'unico modo perché aggiungerne uno resti UNA modifica.
        for (const agent of TERMINAL_AGENT_TYPES) {
          const pres = TERMINAL_AGENT_PRESENTATION[agent];
          items.push({
            id: agent,
            label: TERMINAL_AGENT_LABELS[agent],
            mnemonic: ADD_MENU_MNEMONICS[agent],
            testId: agent === 'shell' ? 'pane-add-menu-shell' : `pane-add-menu-${agent}`,
            run: () => onAddPane('terminal', agent),
            icon:
              pres.icon === 'claude' ? { kind: 'claude' }
              : pres.icon === 'codex' ? { kind: 'codex' }
              : pres.icon === 'cpu' ? { kind: 'lucide', Component: Cpu, color: pres.color }
              : { kind: 'lucide', Component: TerminalSquare, color: getPaneConfig('terminal').color },
          });
        }
        continue;
      }
      const cfg = getPaneConfig(type);
      items.push({
        id: type as AddMenuItemId,
        label: cfg.label,
        mnemonic: ADD_MENU_MNEMONICS[type as AddMenuItemId] ?? '',
        testId: `pane-add-menu-${type}`,
        run: () => onAddPane(type),
        icon: iconFor(type),
      });
    }
  }

  if (onProjectPicker) {
    items.push({
      id: 'open-project',
      label: 'Apri Progetto',
      mnemonic: ADD_MENU_MNEMONICS['open-project'],
      testId: 'pane-add-menu-open-project',
      run: onProjectPicker,
      dividerBefore: true,
      icon: { kind: 'lucide', Component: FolderOpen },
    });
    items.push({
      id: 'create-project',
      label: 'Crea Progetto',
      mnemonic: ADD_MENU_MNEMONICS['create-project'],
      testId: 'pane-add-menu-create-project',
      run: onProjectPicker,
      icon: { kind: 'lucide', Component: FolderPlus },
    });
  }

  return items;
}

/** Dipinge l'icona di una voce. Un solo punto, così le righe del menu e le pill
 *  di ⌘K non possono più mostrare due glifi diversi per la stessa cosa. */
export function AddMenuIcon({ item, size }: { item: AddMenuItem; size: number }) {
  const icon = item.icon;
  if (icon.kind === 'claude') {
    return <ClaudeIcon size={size} className="text-[#D97757] flex-shrink-0" />;
  }
  if (icon.kind === 'codex') {
    return <CodexIcon size={size} className="flex-shrink-0" />;
  }
  const Component = icon.Component;
  if (!Component) return null;
  return <Component size={size} className="flex-shrink-0" style={icon.color ? { color: icon.color } : undefined} />;
}

/** Le voci che la barra pill di ⌘K rende: le stesse del menu standalone, meno
 *  quelle che lì non hanno senso. Esportata perché la lista NON si riscrive. */
export const COMMAND_PALETTE_PILL_IDS: readonly AddMenuItemId[] = [
  'new-chat', 'claude-code', 'codex', 'opencode', 'shell', 'browser', 'open-project', 'create-project',
];
