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
 * chi disegna — righe nel menu, pill nella palette. Il glifo lo dipinge
 * `AddMenuIcon`, che sta in un file suo: un modulo che esporta sia il modello
 * sia un componente spegne il fast refresh di Vite.
 */
import {
  MessageSquare, TerminalSquare, Globe, GitBranch, Activity, BookOpen, Cpu, Kanban,
  BarChart3, LayoutGrid, FolderOpen, FolderTree, FileCode, Eye, Terminal,
  Brain, Clock, UserRound, Bot, type LucideIcon,
} from 'lucide-react';
import { getPaneConfig, getAddableTypesForScope, type PaneScope } from '../../state/pane/adapters';
import { ADD_MENU_MNEMONICS, type AddMenuItemId } from '../../state/pane/adapters/paneMnemonics';
import { TERMINAL_AGENT_TYPES, type TerminalAgentType } from '../../../../shared/terminal-session-types';
import { TERMINAL_AGENT_LABELS } from '../../lib/terminalAgents';
import { isDesktop } from '../../lib/shell';
import type { PaneType } from '../../types';

/** Lookup `PaneConfig.icon` → componente lucide. Da tenere allineata ai nomi in
 *  `PANE_CONFIG`; un nome non mappato non disegna icona (e non rompe niente). */
const ICON_MAP: Record<string, LucideIcon> = {
  MessageSquare, Terminal, TerminalSquare, Globe, GitBranch, FolderTree, FolderOpen,
  FileCode, Activity, BookOpen, Cpu, Kanban, Brain, BarChart3, LayoutGrid, Eye, Clock, UserRound,
};

/** Come si dipinge ogni agente del terminale. `Record<TerminalAgentType, …>`
 *  apposta: aggiungere un agente al registro condiviso NON compila finché non
 *  gli si è dato un volto qui — che è esattamente il controllo che mancava. */
const TERMINAL_AGENT_PRESENTATION: Record<
  TerminalAgentType,
  { icon: 'terminal' | 'claude' | 'codex' | 'cpu' | 'bot'; color?: string }
> = {
  // Viola dalla palette di PANE_CONFIG.terminal: Terminale e Claude Code sono
  // entrambe sessioni pty e devono leggersi come la stessa famiglia — la linea
  // che ora le separa dice «altra categoria», non «altra tecnologia».
  shell: { icon: 'terminal' },
  'claude-code': { icon: 'claude', color: '#D97757' },
  // Mono di proposito: il marchio OpenAI è monocromatico (vedi CodexIcon).
  codex: { icon: 'codex' },
  // opencode → Cerebras GLM-4.7. Teal della dashboard di ripiego; la Cpu
  // ammicca al silicio Cerebras.
  opencode: { icon: 'cpu', color: '#0f8f80' },
  // Kimi Code (Moonshot AI). No dedicated glyph like Claude/Codex yet, so a
  // generic icon (Bot) with a blue distinct from the other three agents.
  'kimi-code': { icon: 'bot', color: '#4C6FFF' },
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
  /** Il picker di sistema «Apri / Crea progetto». La voce compare solo dove ha
   *  senso — variante STANDALONE (da dentro un progetto non se ne apre un
   *  altro) e solo su desktop (serve il dialogo del sistema operativo) — e
   *  quella regola la applica QUESTO modulo, non chi chiama. Finché stava nel
   *  chiamante, ⌘K passava la callback senza condizioni e offriva la voce
   *  anche sul web, dove `selectDirectory` ritorna null: un no-op silenzioso.
   *  Trovato dal gate di parità ADD-09. */
  onProjectPicker?: () => void;
}

/** Ordine curato. `getAddableTypesForScope` restituisce i tipi nell'ordine di
 *  PANE_CONFIG, che va bene per il codice e male per il menu: mette le voci
 *  rare (Files) sopra quelle frequenti (Terminale). I tipi non elencati
 *  finiscono in coda nel loro ordine dichiarato, così aggiungere un
 *  `addableScopes` continua a bastare per farli comparire — ma la coda è il
 *  RIPIEGO, non un posto scelto: `kanban`/`board` ci finivano, e il Board si
 *  leggeva come un ripensamento in fondo al menu. Ora ci sono ENTRAMBI in
 *  questa lista, e possono starci perché non compaiono MAI insieme
 *  (`addableScopes` disgiunti, project vs standalone — la stessa ragione per
 *  cui condividono la mnemonica D). */
const CURATED_ORDER: PaneType[] = ['terminal', 'browser', 'kanban', 'board', 'git', 'files'];

function iconFor(paneType: PaneType) {
  const cfg = getPaneConfig(paneType);
  return { kind: 'lucide' as const, Component: ICON_MAP[cfg.icon] ?? null, color: cfg.color };
}

/** La riga di UN agente del terminale. Estratta perché il blocco terminale non
 *  è più contiguo: la shell sta al suo posto nell'ordine curato, gli agenti
 *  vanno in fondo dopo una linea. Due punti di costruzione sarebbero due
 *  posti da aggiornare per ogni agente nuovo — esattamente il debito che
 *  questo modulo esiste per estinguere (vedi il commento in testa al file). */
function terminalAgentRow(agent: TerminalAgentType, onAddPane: (type: PaneType, subType?: string) => void): AddMenuItem {
  const pres = TERMINAL_AGENT_PRESENTATION[agent];
  return {
    id: agent,
    label: TERMINAL_AGENT_LABELS[agent],
    mnemonic: ADD_MENU_MNEMONICS[agent],
    // `pane-add-menu-shell` è cablato: l'id di riga è `shell`, quindi il
    // template lo produrrebbe uguale — ma resta esplicito perché è un
    // contratto E2E dichiarato (helpers/terminal-workspace.ts,
    // terminal-tab-reload.spec.ts, panels.spec.ts) e non deve poter cambiare
    // di rimbalzo se un giorno l'id cambiasse.
    testId: agent === 'shell' ? 'pane-add-menu-shell' : `pane-add-menu-${agent}`,
    run: () => onAddPane('terminal', agent),
    icon:
      pres.icon === 'claude' ? { kind: 'claude' }
      : pres.icon === 'codex' ? { kind: 'codex' }
      : pres.icon === 'cpu' ? { kind: 'lucide', Component: Cpu, color: pres.color }
      : pres.icon === 'bot' ? { kind: 'lucide', Component: Bot, color: pres.color }
      : { kind: 'lucide', Component: TerminalSquare, color: getPaneConfig('terminal').color },
  };
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
      // Sostantivo secco come ogni altra riga: il verbo lo dice il menu (il suo
      // trigger si chiama «New»). «New Chat» era l'unica voce con un verbo, e
      // si leggeva come una svista invece che come una distinzione.
      label: 'Chat',
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
        // SOLO la shell qui. Prima questo ramo sputava tutti e quattro gli
        // agenti in blocco, ed era QUELLO — non `CURATED_ORDER` — il motivo per
        // cui Browser e Board finivano dopo Claude Code: finché il blocco era
        // atomico non c'era modo di infilare niente in mezzo. Gli agenti vanno
        // sotto la linea, appesi dopo il loop.
        items.push(terminalAgentRow('shell', onAddPane));
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

    // Gli agenti CLI, staccati da una linea: aprono una sessione con un modello
    // dentro, non una pane vuota da riempire — sono un'altra categoria di cosa,
    // e il menu deve dirlo prima che l'utente legga i nomi.
    //
    // Gated su `terminal`: senza, uno scope che non può ospitare un terminale
    // mostrerebbe tre agenti orfani il cui `run` chiama `onAddPane('terminal')`
    // su un tipo che quello scope non accetta.
    //
    // La lista viene dal registro condiviso, non scritta qui: è l'unico modo
    // perché aggiungere un agente resti UNA modifica.
    if (scopeTypes.includes('terminal')) {
      const agents = TERMINAL_AGENT_TYPES.filter((a) => a !== 'shell');
      agents.forEach((agent, i) => {
        const row = terminalAgentRow(agent, onAddPane);
        items.push(i === 0 ? { ...row, dividerBefore: true } : row);
      });
    }
  }

  if (onProjectPicker && scope === 'standalone' && isDesktop) {
    // UNA riga, non due. «Apri Progetto» e «Crea Progetto» chiamavano la STESSA
    // funzione — e non per una svista di cablaggio: non esiste una API «crea»
    // separata da chiamare. Il pannello di sistema (`selectDirectory`, titolato
    // «Apri / Crea progetto») fa entrambe le cose col suo bottone «Nuova
    // cartella», e `POST /api/projects` rifiuta un path inesistente. Due voci
    // indistinguibili sono una promessa che il prodotto non mantiene.
    // L'ellissi e' la convenzione macOS per «apre un dialogo».
    items.push({
      id: 'open-project',
      label: 'Progetto…',
      mnemonic: ADD_MENU_MNEMONICS['open-project'],
      testId: 'pane-add-menu-open-project',
      run: onProjectPicker,
      dividerBefore: true,
      icon: { kind: 'lucide', Component: FolderOpen },
    });
  }

  return items;
}
