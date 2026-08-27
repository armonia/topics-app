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
 *
 * THE ENTRIES CARRY A KEY, NOT A SENTENCE. The descriptions used to be English
 * literals in an app whose default language is Italian, and they were read on
 * two surfaces at once: the `/` completion menu and what `/help` prints. This
 * is a module and not a component, so `tr()` cannot be called here; whoever
 * draws resolves the key, and there are only two such places. The `cmd` itself
 * is NOT translated: it is what one types.
 *
 * `slashCommands.i18n.test.ts` checks the keys exist in both languages, so a
 * new command with a key nobody wrote cannot print `chat.slash.x.description`
 * to a person.
 */
export const SLASH_COMMANDS = [
  // `Info` and not a bolt: nothing is being sped up here, a state is being
  // read. In this app the bolt means ONE thing only — speed — and it belongs to
  // Fast Mode.
  { cmd: '/status', descriptionKey: 'chat.slash.status.description', icon: Info },
  { cmd: '/context', descriptionKey: 'chat.slash.context.description', icon: Gauge },
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
  { cmd: '/compact', descriptionKey: 'chat.slash.compact.description', icon: ChevronsDownUp },
  { cmd: '/clear', descriptionKey: 'chat.slash.clear.description', icon: Trash2 },
  { cmd: '/model', descriptionKey: 'chat.slash.model.description', icon: Cpu },
  { cmd: '/effort', descriptionKey: 'chat.slash.effort.description', icon: Brain },
  { cmd: '/reasoning', descriptionKey: 'chat.slash.reasoning.description', icon: Brain },
  { cmd: '/agents', descriptionKey: 'chat.slash.agents.description', icon: Users },
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
  { cmd: '/resume', descriptionKey: 'chat.slash.resume.description', icon: Play },
  { cmd: '/project', descriptionKey: 'chat.slash.project.description', icon: FolderOpen },
  { cmd: '/browser', descriptionKey: 'chat.slash.browser.description', icon: Globe },
  { cmd: '/goal', descriptionKey: 'chat.slash.goal.description', icon: Target },
  { cmd: '/help', descriptionKey: 'chat.slash.help.description', icon: HelpCircle },
];
