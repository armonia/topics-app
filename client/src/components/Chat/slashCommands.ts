import { Brain, ChevronsDownUp, Cpu, FolderOpen, Gauge, Globe, HelpCircle, Info, Play, Target, Trash2, Users } from 'lucide-react';

/**
 * The slash commands the composer offers.
 *
 * ITS OWN MODULE, and not by taste. It lived in `ChatInput.tsx`, exported from
 * a file that also exports a component: React Fast Refresh cannot tell a
 * constant from a component across a reload, so it gives up on the whole file
 * and does a full page reload on every edit to the composer — and
 * `react-refresh/only-export-components` said so as a lint error. A data list
 * two components read is not part of either one.
 *
 * `/help` is BUILT FROM THIS LIST. It used to be a second hand-written array in
 * `ChatPane`, and the two drifted exactly the way two hand-kept lists always
 * do: `/help` named ten commands while the menu offered more, so the one place
 * a user goes to ask "what can I type here" gave the shorter, older answer.
 * Derived, they cannot disagree.
 *
 * `slashCommandRouting.test.ts` guards the other half: every entry here must
 * have somewhere to go.
 */
export const SLASH_COMMANDS = [
  // `Info` and not a bolt: nothing is being sped up here, a state is being
  // read. In this app the bolt means ONE thing only — speed — and it belongs to
  // Fast Mode.
  { cmd: '/status', label: 'Status', description: 'Show session status', icon: Info },
  { cmd: '/context', label: 'Context', description: 'Show context-window usage (tokens, budget, sources)', icon: Gauge },
  // Compaction already existed, and the app even draws its outcome (the
  // "context compacted" dividers, partitionMarkers.ts), but the ONLY way to
  // start it was the "Compact now" button inside the context warning — which
  // only appears above the threshold and disappears the moment it is dismissed.
  // There was no permanent way to ask for it, and `/help` did not even name it.
  //
  // No client-side handler is needed: `handleSlashCommand` does not intercept
  // it, so the message travels straight to the CLI, which knows `/compact` by
  // itself. That is exactly what the button does
  // (`sendMessageDirect('/compact')`). Listed here it becomes a first-class
  // entry on both surfaces this array feeds: the `/` autocomplete and the
  // overflow menu, which is always reachable.
  { cmd: '/compact', label: 'Compact', description: 'Compatta il contesto ora (riassume la storia e libera spazio)', icon: ChevronsDownUp },
  { cmd: '/clear', label: 'Clear', description: 'Clear conversation', icon: Trash2 },
  { cmd: '/model', label: 'Model', description: 'Change model (e.g. /model claude-opus-5[1m])', icon: Cpu },
  { cmd: '/effort', label: 'Effort', description: 'Set reasoning effort (low|medium|high|xhigh|max)', icon: Brain },
  { cmd: '/reasoning', label: 'Reasoning', description: 'Toggle reasoning (openclaw) / → /effort on claude-code', icon: Brain },
  { cmd: '/agents', label: 'Agents', description: 'List agent profiles', icon: Users },
  // `/pause` and `/assign` used to sit around this one, offering "Pause agent
  // (@name)" and "Assign task (@name task)". Neither had a destination: no
  // handler in `ChatPane`, and not in the server's `CLI_BUILTINS` allowlist
  // either, so choosing one from the menu sent the literal text to the model as
  // prose — with the whole context preamble in front of it. A menu entry that
  // does nothing is worse than no entry, because it also spends the user's
  // trust in the menu. `slashCommandRouting.test.ts` now makes the class
  // impossible: every entry here must be handled or allowlisted.
  //
  // Half of `/pause` does exist, and this is where whoever builds it should
  // start: `pauseSession` / `resumeSession` are declared on the provider
  // interface (`server/providers/types.ts:590`) and implemented for openclaw
  // (`providers/openclaw.ts:189`). Nothing calls either. The capability and
  // the menu entry were built from opposite ends and never met.
  { cmd: '/resume', label: 'Resume', description: 'Resume agent (@name)', icon: Play },
  { cmd: '/project', label: 'Project', description: 'Create or open a project', icon: FolderOpen },
  { cmd: '/browser', label: 'Browser', description: 'Open browser tab and navigate (e.g. /browser https://example.com)', icon: Globe },
  { cmd: '/goal', label: 'Goal', description: "Obiettivo della chat: /goal <testo> · /goal fatto · /goal basta", icon: Target },
  { cmd: '/help', label: 'Help', description: 'Show available commands', icon: HelpCircle },
];
