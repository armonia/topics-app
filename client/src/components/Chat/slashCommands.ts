import type { ComponentType } from 'react';
import {
  Brain, ChevronsDownUp, Cpu, Download, FolderOpen, Gauge, GitBranch, Globe, HelpCircle, History, Info, PenLine,
  Plug, RotateCcw, Settings2, ShieldCheck, Target, TerminalSquare, Trash2, Wallet, Zap,
} from 'lucide-react';

/**
 * THE «TOPICS» GROUP OF THE «/» MENU: the commands Topics runs itself or the
 * controls it opens (CMDUI-01). The engine's own commands and the person's
 * skills come from the engine (`GET /api/slash-commands`), and every name of
 * the three groups passes through `commandMap.ts`.
 *
 * ITS OWN MODULE, and not by taste. It lived in `ChatInput.tsx`, exported from
 * a file that also exports a component: React Fast Refresh cannot tell a
 * constant from a component across a reload, so it gives up on the whole file
 * and does a full page reload on every edit to the composer. A data list two
 * components read is not part of either one.
 *
 * `/help` IS THE MENU (CMDUI-07): it opens it, instead of printing a second
 * list that drifts from this one.
 *
 * `slashCommandRouting.test.ts` guards the other half: every entry here must
 * have somewhere to go.
 *
 * THE ENTRIES CARRY A KEY, NOT A SENTENCE. This is a module and not a
 * component, so `tr()` cannot be called here; whoever draws resolves the key.
 * The `cmd` itself is NOT translated: it is what one types.
 */
export interface SlashCommandEntry {
  readonly cmd: string;
  readonly descriptionKey: string;
  readonly icon: ComponentType<{ size?: number; className?: string }>;
  /** `control` opens a control of Topics (or sets it with an argument); `topics` is run by Topics. */
  readonly kind: 'topics' | 'control';
  /** For a control: what it opens, said on its row («apre il selettore»). */
  readonly opensKey?: string;
  /** It wants an argument: picking it inserts `/x ` and waits instead of running. */
  readonly takesArgs?: boolean;
  /**
   * The providers a topic must DECLARE (CMD-08) for the entry to be offered.
   * Absent = every provider.
   */
  readonly onlyOn?: readonly string[];
  /** The providers that have their own command under this name: there it travels as typed. */
  readonly notOn?: readonly string[];
}

/** Engines with a compaction to ask for (CMDUI-06): the CLI, the gateway, the native engine. */
const COMPACTS = ['claude-code', 'claude-code-team', 'openclaw', 'topics'];
/** OpenClaw's gateway runs its own `/mcp`, `/config`, `/export` and `/usage`. */
const OPENCLAW = ['openclaw'];

export const SLASH_COMMANDS: readonly SlashCommandEntry[] = [
  // `Info` and not a bolt: a state is being read. In this app the bolt means
  // ONE thing only — speed — and it belongs to Fast Mode.
  { cmd: '/status', descriptionKey: 'chat.slash.status.description', icon: Info, kind: 'topics' },
  // The sessions of this project born outside Topics, adopted as a chat (CMDUI-03).
  { cmd: '/resume', descriptionKey: 'chat.slash.resume.description', icon: History, kind: 'topics', takesArgs: true },
  { cmd: '/model', descriptionKey: 'chat.slash.model.description', icon: Cpu, kind: 'control', opensKey: 'chat.slash.opens.model' },
  { cmd: '/effort', descriptionKey: 'chat.slash.effort.description', icon: Brain, kind: 'control', opensKey: 'chat.slash.opens.effort', notOn: OPENCLAW },
  { cmd: '/context', descriptionKey: 'chat.slash.context.description', icon: Gauge, kind: 'control', opensKey: 'chat.slash.opens.context' },
  { cmd: '/permissions', descriptionKey: 'chat.slash.permissions.description', icon: ShieldCheck, kind: 'control', opensKey: 'chat.slash.opens.autonomy' },
  { cmd: '/fast', descriptionKey: 'chat.slash.fast.description', icon: Zap, kind: 'control', opensKey: 'chat.slash.opens.fast', onlyOn: ['claude-code', 'claude-code-team'] },
  { cmd: '/usage', descriptionKey: 'chat.slash.usage.description', icon: Wallet, kind: 'control', opensKey: 'chat.slash.opens.providers', notOn: OPENCLAW },
  { cmd: '/mcp', descriptionKey: 'chat.slash.mcp.description', icon: Plug, kind: 'control', opensKey: 'chat.slash.opens.tools', notOn: OPENCLAW },
  { cmd: '/config', descriptionKey: 'chat.slash.config.description', icon: Settings2, kind: 'control', opensKey: 'chat.slash.opens.userMenu', notOn: OPENCLAW },
  // Compaction already existed and the app draws its outcome (the «context
  // compacted» dividers), but the only way to start it was a button that
  // appears above the threshold. Here it is permanent, on the engines that
  // compact on request: the CLI and the gateway run it, the native engine
  // compacts now (`/api/command` `compact`).
  { cmd: '/compact', descriptionKey: 'chat.slash.compact.description', icon: ChevronsDownUp, kind: 'topics', onlyOn: COMPACTS },
  { cmd: '/clear', descriptionKey: 'chat.slash.clear.description', icon: Trash2, kind: 'topics' },
  { cmd: '/goal', descriptionKey: 'chat.slash.goal.description', icon: Target, kind: 'topics', takesArgs: true },
  // Handled in `ChatPane` (the same call as the message's «Fork into a new
  // chat»), and NOT in the server's `CLI_BUILTINS`: the CLI never receives it.
  { cmd: '/fork', descriptionKey: 'chat.slash.fork.description', icon: GitBranch, kind: 'topics', takesArgs: true },
  { cmd: '/rewind', descriptionKey: 'chat.slash.rewind.description', icon: RotateCcw, kind: 'topics' },
  { cmd: '/project', descriptionKey: 'chat.slash.project.description', icon: FolderOpen, kind: 'topics' },
  { cmd: '/browser', descriptionKey: 'chat.slash.browser.description', icon: Globe, kind: 'topics', takesArgs: true },
  // The chat of Topics, not the CLI's session (which the CLI's own /rename names).
  { cmd: '/rename', descriptionKey: 'chat.slash.rename.description', icon: PenLine, kind: 'topics', takesArgs: true },
  { cmd: '/export', descriptionKey: 'chat.slash.export.description', icon: Download, kind: 'topics', notOn: OPENCLAW },
  { cmd: '/reasoning', descriptionKey: 'chat.slash.reasoning.description', icon: Brain, kind: 'topics', onlyOn: OPENCLAW },
  { cmd: '/help', descriptionKey: 'chat.slash.help.description', icon: HelpCircle, kind: 'topics' },
];

/** The icon of a row of the engine's group or of the skills. */
export const ENGINE_COMMAND_ICON = TerminalSquare;

/**
 * The entries offered to a topic whose DECLARED provider is `provider`
 * (`topic.provider`, or the server's default when the topic names none).
 * Unknown provider = everything without a restriction.
 */
export function offeredSlashCommands(provider: string | null | undefined): readonly SlashCommandEntry[] {
  return SLASH_COMMANDS.filter((c) =>
    (!c.onlyOn || (!!provider && c.onlyOn.includes(provider)))
    && (!c.notOn || !provider || !c.notOn.includes(provider)));
}
