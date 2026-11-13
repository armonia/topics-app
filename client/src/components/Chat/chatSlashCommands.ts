import { useCallback, useEffect, type RefObject } from 'react';
import type { Topic, ChatMessage, CompactionMarker, UpdateTopicRequest } from '../../types';
import type { SendMessageOptions } from '../../hooks/useChat';
import { getSystemHealth, apiErrorCode, commandApi, type CommandResult } from '../../lib/api';
import { errMessage } from '../../lib/errMessage';
import { getProvidersSnapshotState } from '../../lib/providersSnapshotStore';
import { isDraftTopicId } from '../../lib/composerMemory';
import { shortcut } from '../../lib/shortcutLabel';
import { openUserMenu } from '../../lib/openUserMenu';
import { COMMAND_ANSWER_EVENT, statusRows, type CommandAnswer, type CommandAnswerEventDetail } from '../../lib/commandAnswer';
import { providerLabel } from '../../../../shared/provider-labels';
import { restoreLastTurnCheckpoint, RestoreRefusedError } from '../../hooks/useCheckpoints';
import { rewindFailureText } from './checkpointPlan';
import { canonicalCommand, invokedName, topicsEntryFor } from './commandMap';
import { cliRefusedCommand, isClearCommand, topicsHomeCommand } from './cliRefused';
import type { ComposerControls } from './ChatInput';
import type { useConfirm } from '../../hooks/useConfirm';
import type { useGoal } from '@/hooks/useGoal';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** A compaction waiting for its outcome, see the watch effect below. */
type CompactWatch = { before: number; messagesBefore: number; sawIdle: boolean; sawTurn: boolean };

/** The sentence of each `/project` refusal, by the code the route answers with. */
const PROJECT_ERROR_KEY: Record<string, string> = {
  project_name_required: 'chat.project.usageCreate',
  project_name_invalid: 'chat.project.nameInvalid',
  project_exists: 'chat.project.exists',
  project_target_required: 'chat.project.usageOpen',
  project_not_found: 'chat.project.notFound',
};

/** What `/project` answered, as lines in the reader's language. */
function projectInfoLines(r: CommandResult & { code?: string; name?: string; path?: string | null; projects?: string[]; moreProjects?: number }, tr: Translate): string[] {
  if (r.code === 'project_created') return [tr('chat.project.created', { name: r.name ?? '', path: r.path ?? '' })];
  if (r.code === 'project_opened') return [tr('chat.project.opened', { path: r.path ?? '' })];
  const lines = [r.path ? tr('chat.project.current', { path: r.path }) : tr('chat.project.none')];
  const projects = r.projects ?? [];
  if (projects.length > 0) {
    lines.push('', tr('chat.project.workspace'));
    for (const p of projects) lines.push(`  ${p.split('/').pop() || p} · ${p}`);
    if (r.moreProjects) lines.push(tr('chat.project.more', { count: r.moreProjects }));
  }
  return lines;
}

interface CommandAnswerEffectsParams {
  topic: Topic;
  tr: Translate;
  currentMarkers: CompactionMarker[] | undefined;
  currentStreaming: boolean;
  compactWatchRef: RefObject<CompactWatch | null>;
  compactSaidRef: RefObject<string | null>;
  setCommandAnswer: (answer: CommandAnswer | null) => void;
}

/** The two effects that turn the engine's command answers and a compaction's end into the answer card. */
export function useCommandAnswerEffects({
  topic, tr, currentMarkers, currentStreaming, compactWatchRef, compactSaidRef, setCommandAnswer,
}: CommandAnswerEffectsParams): void {
  // Closes the compaction banner with the TRUE outcome, when the marker
  // arrives. `stream:compaction` carries the before/after tokens, so it can
  // say how much was freed instead of a generic "done".
  //
  // THE TURN ENDING WITHOUT A MARKER IS AN OUTCOME TOO. The CLI answers a
  // compaction it cannot do («Not enough messages to compact.») with a
  // message and the end of the turn, and no marker. The watch used to wait
  // for a marker only, with a cap checked only when markers changed: the
  // «compacting» notice never turned into the failure, and the watch never
  // closed.
  useEffect(() => {
    const w = compactWatchRef.current;
    if (!w) return;
    const markers = currentMarkers ?? [];
    if (markers.length > w.before) {
      compactWatchRef.current = null;
      const last = markers[markers.length - 1];
      const pre = last?.preTokens;
      const post = last?.postTokens;
      setCommandAnswer({
        kind: 'facts',
        title: '/compact',
        body: typeof pre === 'number' && typeof post === 'number'
          ? tr('chat.compact.done', { before: pre.toLocaleString(), after: post.toLocaleString() })
          : tr('chat.compact.doneNoCount'),
      });
      return;
    }
    // A turn already running when `/compact` was sent is not the compaction's:
    // the outcome is the end of a turn that STARTED after an idle moment.
    if (currentStreaming) { if (w.sawIdle) w.sawTurn = true; return; }
    if (!w.sawTurn) { w.sawIdle = true; return; }
    compactWatchRef.current = null;
    // The reason is what the CLI said in that turn (its command answer, which
    // is never a message of the chat any more), when it said something.
    const said = compactSaidRef.current;
    setCommandAnswer({ kind: 'error', title: '/compact', body: said ? tr('chat.compact.notDone', { reason: said }) : tr('chat.compact.notDoneNoReason') });
  }, [currentMarkers, currentStreaming, tr, compactWatchRef, compactSaidRef, setCommandAnswer]);

  // THE ANSWER OF A COMMAND, from the engine (CMDUI-04): the CLI's own words
  // for a local command, and `/compact`'s outcome. Into the card, never into
  // the thread. A failed compaction closes its watch with the CLI's reason.
  useEffect(() => {
    const onAnswer = (e: Event) => {
      const d = (e as CustomEvent<CommandAnswerEventDetail>).detail;
      if (!d || d.sessionKey !== topic.sessionKey) return;
      if (d.command === 'compact') {
        const reason = d.outcome?.error ?? d.text;
        compactSaidRef.current = reason || null;
        if (d.outcome?.ok === true) return; // the marker tells the tokens
        compactWatchRef.current = null;
        setCommandAnswer({ kind: 'error', title: '/compact', body: reason ? tr('chat.compact.notDone', { reason }) : tr('chat.compact.notDoneNoReason') });
        return;
      }
      if (!d.text) return;
      setCommandAnswer({ kind: 'text', title: `/${d.command}`, body: d.text });
    };
    window.addEventListener(COMMAND_ANSWER_EVENT, onAnswer);
    return () => window.removeEventListener(COMMAND_ANSWER_EVENT, onAnswer);
  }, [topic.sessionKey, tr, compactWatchRef, compactSaidRef, setCommandAnswer]);
}

interface SlashCommandParams {
  topic: Topic;
  tr: Translate;
  locale: string;
  isGlobalOrchestrator: boolean;
  loadHistory: (sk: string) => Promise<boolean>;
  goal: ReturnType<typeof useGoal>['goal'];
  declareGoal: ReturnType<typeof useGoal>['declare'];
  closeGoal: ReturnType<typeof useGoal>['close'];
  confirm: ReturnType<typeof useConfirm>;
  sendMessage: (sk: string, content: string, options?: SendMessageOptions) => Promise<boolean>;
  getCompactionMarkers?: (sk: string) => CompactionMarker[];
  forkHere: (prompt?: string) => Promise<void>;
  askSideQuestion: (question: string) => Promise<unknown>;
  currentMessages: ChatMessage[];
  currentStreaming: boolean;
  handleExportConversation: () => void;
  setCommandResult: (r: { type: 'success' | 'error'; message: string; action?: CommandAnswer['action'] } | null) => void;
  setCommandAnswer: (answer: CommandAnswer | null) => void;
  setCommandLoading: (loading: boolean) => void;
  commandTitleRef: RefObject<string>;
  composerControlsRef: RefObject<ComposerControls | null>;
  compactSaidRef: RefObject<string | null>;
  compactWatchRef: RefObject<CompactWatch | null>;
  sendMessageRef: RefObject<((text: string) => Promise<unknown>) | null>;
  toggleFastModeRef: RefObject<(() => void) | null>;
  fastMode: boolean;
  onUpdateTopic: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
}

/** The slash-command funnel of the chat: true when the text was a command answered here. */
export function useSlashCommandHandler({
  topic, tr, locale, isGlobalOrchestrator, loadHistory, goal, declareGoal, closeGoal, confirm, sendMessage,
  getCompactionMarkers, forkHere, askSideQuestion, currentMessages, currentStreaming, handleExportConversation,
  setCommandResult, setCommandAnswer, setCommandLoading, commandTitleRef, composerControlsRef, compactSaidRef,
  compactWatchRef, sendMessageRef, toggleFastModeRef, fastMode, onUpdateTopic,
}: SlashCommandParams) {
  return useCallback(async (text: string): Promise<boolean> => {
    // The provider the topic DECLARES (CMD-08), the same one the menu is
    // filtered by (`ChatInput`): the refusals and the aliases below are
    // Claude Code's, and other providers run those names themselves.
    const declared = topic.provider || getProvidersSnapshotState().snapshot?.providers.find((p) => p.isDefault)?.name || null;
    // AN ALIAS IS ITS COMMAND (CMDUI-01): `/cost` is `/usage` on Claude Code,
    // `/new` and `/reset` are `/clear` on every engine. Resolved
    // before every branch; the text that travels to the engine, when one does,
    // is the one typed.
    const invoked = invokedName(text);
    const canonical = invoked ? canonicalCommand(invoked, declared) : null;
    const cmd = canonical ? `/${canonical}${text.trimStart().slice(invoked!.length + 1)}`.toLowerCase().trim() : text.toLowerCase().trim();
    commandTitleRef.current = canonical ? `/${canonical}` : '';
    if (isGlobalOrchestrator && cmd.startsWith('/')) {
      setCommandResult({ type: 'error', message: tr('chat.orchestrator.slashBlocked') });
      return true;
    }
    // `/health` reads the server's subsystem snapshot directly, without a model turn.
    if (cmd === '/health' || cmd.startsWith('/health ')) {
      setCommandLoading(true);
      try {
        const health = await getSystemHealth();
        const stateLabel: Record<string, string> = { ok: tr('systemHealth.state.ok'), warn: tr('systemHealth.state.warn'), error: tr('systemHealth.state.error'), off: tr('systemHealth.state.off') };
        const rows = health.subsystems.flatMap((item) => [
          { label: tr(`systemHealth.name.${item.id}`), value: `${stateLabel[item.state]}: ${tr(`systemHealth.reason.${item.reason}`, item.params)}` },
          ...(item.state !== 'ok' ? [{ label: tr('systemHealth.actionLabel'), value: tr(`systemHealth.action.${item.reason}`, item.params) }] : []),
          ...(item.lastError ? [{ label: tr('systemHealth.lastErrorLabel'), value: tr('systemHealth.lastError', { message: item.lastError.message, at: new Date(item.lastError.at).toLocaleString(locale) }) }] : []),
        ]);
        setCommandAnswer({ kind: 'facts', title: tr('chat.command.title.health'), rows });
      } catch (e) {
        setCommandResult({ type: 'error', message: errMessage(e) });
      } finally { setCommandLoading(false); }
      return true;
    }
    // `/status` is the facts that decide the next turn (CMD-07), as rows.
    if (cmd === '/status' || cmd.startsWith('/status ')) { setCommandLoading(true); try { const r = await commandApi.status(topic.sessionKey); setCommandAnswer({ kind: 'facts', title: tr('chat.command.title.status'), rows: statusRows(r.output || '') }); } catch (e) { setCommandResult({ type: 'error', message: errMessage(e) }); } finally { setCommandLoading(false); } return true; }
    // `/help` IS the menu, whole (CMDUI-07): a second list would drift from it.
    // After the send has emptied the field: the menu puts its own `/` there.
    if (cmd === '/help' || cmd.startsWith('/help ')) { setCommandAnswer(null); setTimeout(() => composerControlsRef.current?.openCommands(), 0); return true; }
    if (cmd === '/btw' || cmd.startsWith('/btw ')) {
      const question = text.trim().slice('/btw'.length).trim();
      if (!question) { setCommandResult({ type: 'error', message: tr('chat.btw.usage') }); return true; }
      if (!topicsEntryFor('btw', declared)) return false;
      setCommandAnswer(null);
      void askSideQuestion(question);
      return true;
    }
    // `/resume` (CMDUI-03): the sessions of this project born outside Topics.
    // Its list opens over the composer; without a project there is none.
    if (cmd === '/resume' || cmd.startsWith('/resume ')) {
      if (!topic.projectPath || isDraftTopicId(topic.id)) { setCommandResult({ type: 'error', message: tr('chat.resume.noProject') }); return true; }
      setCommandAnswer(null);
      const filter = text.trim().slice('/resume'.length).trim();
      setTimeout(() => composerControlsRef.current?.openResume(filter), 0);
      return true;
    }
    // `/permissions` opens the autonomy selector beside the field (CMDUI-02).
    if (cmd === '/permissions' || cmd.startsWith('/permissions ')) { setCommandAnswer(null); composerControlsRef.current?.openAutonomy(); return true; }
    // `/fast` is the fast-mode switch, where there is one; `/fast on|off` sets it.
    if ((cmd === '/fast' || cmd.startsWith('/fast ')) && topicsEntryFor('fast', declared)) {
      const want = cmd.slice('/fast'.length).trim();
      if (!want) { setCommandAnswer(null); composerControlsRef.current?.openFast(); return true; }
      if (want !== 'on' && want !== 'off') { setCommandResult({ type: 'error', message: tr('chat.fast.usage') }); return true; }
      if ((want === 'on') !== fastMode) toggleFastModeRef.current?.();
      setCommandResult({ type: 'success', message: tr(want === 'on' ? 'chat.fast.on' : 'chat.fast.off') });
      return true;
    }
    // `/rename <name>` names the chat of Topics, not the CLI's session.
    if (cmd === '/rename' || cmd.startsWith('/rename ')) {
      const name = text.trim().slice(text.trim().split(/\s/, 1)[0]!.length).trim();
      if (!name) { setCommandResult({ type: 'error', message: tr('chat.rename.usage') }); return true; }
      await onUpdateTopic(topic.id, { name });
      setCommandResult({ type: 'success', message: tr('chat.rename.done', { name }) });
      return true;
    }
    // `/export` downloads the chat as Markdown.
    if ((cmd === '/export' || cmd.startsWith('/export ')) && topicsEntryFor('export', declared)) {
      if (currentMessages.length === 0) { setCommandResult({ type: 'error', message: tr('chat.export.empty') }); return true; }
      handleExportConversation();
      setCommandResult({ type: 'success', message: tr('chat.export.done') });
      return true;
    }
    // `/context` opens the inspector the ring opens. It used to print the
    // envelope's own estimate in a banner while the ring, one row below, read
    // the model's real count: two answers to one question, the banner the
    // wrong one.
    // A draft has no ring and no inspector yet: say so instead of nothing.
    if (cmd === '/context') { if (isDraftTopicId(topic.id)) { setCommandResult({ type: 'success', message: tr('chat.context.draft') }); return true; } setCommandResult(null); composerControlsRef.current?.openContext(); return true; }
    // `/new` and `/reset` are `/clear` on every engine with a session
    // (CMDUI-06): on Claude Code forwarded, the live process forgot while the
    // screen kept the history; elsewhere they were prose to the model (`isClearCommand`).
    if (isClearCommand(cmd, declared)) { if (!await confirm({ title: tr('chat.clear.title'), body: tr('chat.clear.body'), confirmLabel: tr('chat.clear.confirm') })) return true; setCommandLoading(true); try { await commandApi.clear(topic.sessionKey); loadHistory(topic.sessionKey); setCommandResult({ type: 'success', message: tr('chat.clear.done') }); } catch (e) { setCommandResult({ type: 'error', message: errMessage(e) }); } finally { setCommandLoading(false); } return true; }
    // `/reasoning` has no switch on any provider: the server answers with the declared provider and points at `/effort`.
    if (cmd === '/reasoning' || cmd.startsWith('/reasoning ')) { setCommandLoading(true); try { const r = await commandApi.toggleReasoning(topic.sessionKey); setCommandResult({ type: 'success', message: r.message || '' }); } catch (e) { setCommandResult({ type: 'error', message: errMessage(e) }); } finally { setCommandLoading(false); } return true; }
    if (cmd === '/fork' || cmd.startsWith('/fork ')) { await forkHere(text.trim().slice('/fork'.length)); return true; }

    // `/rewind` is answered here rather than forwarded, because forwarding it
    // does NOTHING and says nothing about it.
    //
    // The CLI marks the command `supportsNonInteractive: false` in its own
    // registry: it is a TUI screen, and Topics runs the CLI with `--print`. But
    // `rewind` is in the server's `CLI_BUILTINS` allowlist, so the message was
    // being delivered faithfully to a process that discards it. No error, no
    // log, you type `/rewind`, nothing happens, and there is nothing to read
    // about why.
    //
    // Now it does the thing: it restores the automatic checkpoint taken before
    // the last turn (`server/services/turn-checkpoints.ts`).
    //
    // WHAT IT SAYS, and why every line of it is there. It reports the file
    // counts, it names the branch HEAD is still on, because the old manual
    // rollback used to leave the repository detached and say nothing, and it
    // states outright that the CONVERSATION did not move. That last line is not
    // filler: "your files are back" and "the chat is back" are two different
    // promises, Topics only keeps the first, and a user who assumes the second
    // discovers the mismatch later, at the worst possible moment.
    if (cmd === '/rewind' || cmd.startsWith('/rewind ') || cmd === '/checkpoint') {
      setCommandLoading(true);
      try {
        const r = await restoreLastTurnCheckpoint(topic.id);
        const when = r.checkpoint.createdAt ? new Date(r.checkpoint.createdAt).toLocaleTimeString() : '';
        setCommandResult({
          type: 'success',
          message: [
            `Albero ripristinato al checkpoint «${r.checkpoint.label}»${when ? ` (${when})` : ''}.`,
            `${r.restored} file rimessi a posto, ${r.removed} creati dal turno rimossi.`,
            r.branch ? `HEAD è ancora su ${r.branch}: nessun detached HEAD.` : 'Attenzione: HEAD era già staccato prima del ripristino.',
            'La CONVERSAZIONE non è tornata indietro: sono i file a essere tornati com\'erano. Per tagliare anche la chat, usa la striscia dei checkpoint sopra il composer.',
          ].join('\n'),
        });
      } catch (e) {
        // A refusal names its blocker in the user's language; the route's own
        // «no project folder» answer says that; anything else (a 500, the
        // network) is said as it is (`rewindFailureText`).
        setCommandResult({
          type: 'error',
          message: rewindFailureText({
            blockedBy: e instanceof RestoreRefusedError ? e.blockedBy : undefined,
            code: apiErrorCode(e),
            message: errMessage(e),
          }, tr),
        });
      } finally {
        setCommandLoading(false);
      }
      return true;
    }

    // /compact: the compaction has a precise OUTCOME, so it deserves a UI,
    // not a generic spinner.
    //
    // The work is done by the CLI (`/compact` is one of its commands) and the
    // outcome already has its representation: the "context compacted" divider
    // with the tokens before and after, which arrives via `stream:compaction`
    // and lives in `currentMarkers`. What was missing was the MEANS: sending
    // the command as a normal chat message made it look like a stuck turn,
    // and the user saw "slow stream, the provider is still connected", which
    // is the generic waiting indicator and says nothing about what is
    // happening. Reported live on 2026-08-02.
    //
    // Here the command is INTERCEPTED: it declares at once what is happening
    // and how long it may take, sends the text to the CLI so it does the
    // work, and lets the divider tell the result. Not intercepting it would
    // not work either: without `sendMessage` the CLI does not compact.
    if (cmd === '/compact' && declared === 'topics') {
      // The native engine has no command parser: it compacts now, through
      // Topics (CMDUI-06), and the divider arrives like the automatic one's.
      setCommandAnswer({ kind: 'running', title: '/compact', body: tr('chat.compact.running') });
      try {
        const r = await commandApi.execute(topic.sessionKey, 'compact') as { compacted?: boolean; before?: number; after?: number };
        setCommandAnswer(r.compacted && typeof r.before === 'number' && typeof r.after === 'number'
          ? { kind: 'facts', title: '/compact', body: tr('chat.compact.done', { before: r.before.toLocaleString(), after: r.after.toLocaleString() }) }
          : { kind: 'text', title: '/compact', body: tr('chat.compact.nothing') });
      } catch (e) {
        setCommandAnswer({ kind: 'error', title: '/compact', body: apiErrorCode(e) === 'turn_in_progress' ? tr('chat.compact.busy') : errMessage(e) });
      }
      return true;
    }
    // An engine that does not compact on request says so, by name (CMDUI-06).
    if (cmd === '/compact' && declared && !topicsEntryFor('compact', declared)) {
      setCommandResult({ type: 'error', message: tr('chat.compact.unsupported', { engine: getProvidersSnapshotState().snapshot?.providers.find((p) => p.name === declared)?.label ?? providerLabel(declared) }) });
      return true;
    }
    if (cmd === '/compact') {
      const markersBefore = getCompactionMarkers?.(topic.sessionKey)?.length ?? 0;
      compactSaidRef.current = null;
      setCommandAnswer({ kind: 'running', title: '/compact', body: tr('chat.compact.running') });
      void sendMessage(topic.sessionKey, '/compact').catch(() => {
        setCommandResult({ type: 'error', message: tr('chat.compact.failed') });
      });
      // The marker arrives asynchronously (stream:compaction). We wait for
      // its increment instead of saying "done" at random: this way the banner
      // reports the TRUE outcome: the marker, or the end of the turn without one.
      compactWatchRef.current = { before: markersBefore, messagesBefore: currentMessages.length, sawIdle: !currentStreaming, sawTurn: false };
      return true;
    }

    // 3.4, /goal: the goal of the conversation. Intercepted HERE, before the
    // model: it is state of the topic, not a message, and sending it to the
    // agent would mean having it rewrite it in a form nobody rereads.
    if (cmd === '/goal' || cmd.startsWith('/goal ')) {
      const rest = text.slice('/goal'.length).trim();
      try {
        if (!rest) {
          setCommandResult(goal
            ? { type: 'success', message: tr('chat.goal.current', { goal: goal.content }) }
            : { type: 'error', message: tr('chat.goal.usage') });
          return true;
        }
        // allow-italian: 'fatto' is typed BY the user; the word is the input, not a label
        if (rest === 'fatto' || rest === 'done') {
          if (!goal) { setCommandResult({ type: 'error', message: tr('chat.goal.none') }); return true; }
          await closeGoal('achieved');
          setCommandResult({ type: 'success', message: tr('chat.goal.achieved', { goal: goal.content }) });
          return true;
        }
        if (rest === 'basta' || rest === 'stop') {
          if (!goal) { setCommandResult({ type: 'error', message: tr('chat.goal.none') }); return true; }
          await closeGoal('abandoned');
          setCommandResult({ type: 'success', message: tr('chat.goal.abandoned', { goal: goal.content }) });
          return true;
        }
        await declareGoal(rest);
        // No confirmation banner here: the bar above the composer and the
        // prompt itself already say it, a third copy in green monospace was
        // noise over the start of the turn.
        setCommandResult(null);
        // AND THE GOAL IS SENT, like Claude Code's `/goal`: declaring it is
        // asking for it. Only saving it left the chat idle until the person
        // wrote the same thing again as a message (23/09). The text goes as a
        // normal turn: the goal is already in the envelope of that turn
        // (`goalContextContent`), and the loop takes over from its end.
        void sendMessageRef.current?.(rest);
      } catch (e) {
        setCommandResult({ type: 'error', message: errMessage(e) });
      }
      return true;
    }
    // Bare `/model` and `/effort` open the controls that already do this,
    // one row below the field. Forwarded, `/model` printed the CLI's English
    // usage with its own aliases, and `/effort` a red «Uso: /effort <…>».
    if (cmd === '/model') { setCommandResult(null); composerControlsRef.current?.openModel(); return true; }
    if (cmd.startsWith('/model ')) { const m = text.slice(7).trim(); if (!m) return false; setCommandLoading(true); try { const r = await commandApi.setModel(topic.sessionKey, m); setCommandResult({ type: 'success', message: r.pending ? tr('chat.command.modelSet', { model: m }) : r.message || `Model set to: ${m}` }); } catch (e) { setCommandResult({ type: 'error', message: errMessage(e) }); } finally { setCommandLoading(false); } return true; }
    if (cmd === '/effort') { setCommandResult(null); composerControlsRef.current?.openEffort(); return true; }
    // Bare `/mcp`, `/config` (with its alias `/settings`) and `/usage` (with
    // `/cost` and `/stats`) open where Topics keeps those things now
    // (SETHOME-01), on Claude Code only: with arguments, or on a provider with
    // its own commands under these names, they travel as typed
    // (`topicsHomeCommand`).
    const home = topicsHomeCommand(cmd, declared);
    if (home === 'tools') { setCommandResult(null); composerControlsRef.current?.openTools(); return true; }
    if (home === 'providers') { setCommandResult(null); composerControlsRef.current?.openProviders(); return true; }
    if (home === 'userMenu') { setCommandResult(null); openUserMenu(); return true; }
    if (cmd.startsWith('/effort ')) { const tier = text.slice(8).trim().toLowerCase(); if (!tier) return false; setCommandLoading(true); try { const r = await commandApi.setEffort(topic.sessionKey, tier); setCommandResult({ type: 'success', message: r.pending ? tr('chat.command.effortSet', { level: tier }) : r.message || `Effort set to: ${tier}` }); } catch (e) { setCommandResult({ type: 'error', message: errMessage(e) }); } finally { setCommandLoading(false); } return true; }

    // /project, info / create <name> / open <path-or-name>. The route answers
    // with a code and data, the sentence is written here in the reader's
    // language (it used to be the server's English, with emoji).
    if (cmd === '/project' || cmd.startsWith('/project ')) {
      const rest = text.trim().slice('/project'.length).trim();
      let sub: 'create' | 'open' | 'info' = 'info';
      let value = '';
      if (rest.startsWith('create ')) { sub = 'create'; value = rest.slice(7).trim(); }
      else if (rest === 'create') { setCommandResult({ type: 'error', message: tr('chat.project.usageCreate') }); return true; }
      else if (rest.startsWith('open ')) { sub = 'open'; value = rest.slice(5).trim(); }
      else if (rest === 'open') { setCommandResult({ type: 'error', message: tr('chat.project.usageOpen') }); return true; }
      setCommandLoading(true);
      try {
        const r = await commandApi.project(topic.sessionKey, sub, value || undefined);
        const info = projectInfoLines(r, tr);
        setCommandResult({ type: 'success', message: info.join('\n') });
      } catch (e) {
        const key = PROJECT_ERROR_KEY[apiErrorCode(e) ?? ''];
        setCommandResult({ type: 'error', message: key ? tr(key, { value }) : errMessage(e) });
      } finally { setCommandLoading(false); }
      return true;
    }

    // Phase 30 BROWSER-CHAT-04, /browser <url> opens or focuses the topic's
    // browser pane and navigates. Intercepted BEFORE LLM dispatch.
    // Bare, it is what picking the menu row sends (`/browser ` trimmed): it
    // used to miss this branch and reach the model with the context preamble.
    if (cmd === '/browser') { setCommandResult({ type: 'error', message: tr('chat.browser.usage') }); return true; }
    if (cmd.startsWith('/browser ')) {
      const url = text.trim().slice('/browser '.length).trim();
      // Normalize: prepend https:// when no protocol given.
      const normalized = /^https?:\/\//.test(url) ? url : `https://${url}`;
      // Loosely-coupled signal: layout layer listens for browser:open-and-navigate
      // and ensureBrowserPane + navigates. Mirrors the existing browser:navigate
      // CustomEvent pattern used by server-driven detection.
      // `source` is what tells this apart from the OTHER producer of the same
      // event (the task drawer): only the command typed in the composer is an
      // explicit request to LOOK, so only it opens the topic's window expanded.
      // See the handler in `usePaneOrdering` (effect 8b).
      window.dispatchEvent(new CustomEvent('browser:open-and-navigate', {
        detail: { topicId: topic.id, url: normalized, source: 'slash-command' },
      }));
      setCommandResult({ type: 'success', message: tr('chat.command.openingBrowser', { url: normalized }) });
      return true;
    }

    // Phase 30 BROWSER-CHAT-04, @browser <prompt> is a user-side mnemonic.
    // No special parsing: the message flows to the LLM normally, and since
    // browserTools are registered for SDK providers (claude/openai), the model
    // sees them and decides when to call. Returning false lets sendMessage
    // dispatch the original text to the chat pipeline.

    // The Claude Code commands that cannot run where Topics runs the CLI
    // (CMD-06): answered here, saying what to use in Topics instead
    // (`cliRefused.ts`). They used to reach the CLI, which can only answer
    // «/X isn't available in this environment.», in English, as the agent.
    const refusedCli = cliRefusedCommand(cmd, declared);
    if (refusedCli) {
      // A command of the terminal offers a terminal in the project, with the
      // CLI typed and not run: there the command works.
      const action = refusedCli.answer.terminal
        ? { label: tr('chat.cliRefused.openTerminal'), run: () => { window.dispatchEvent(new CustomEvent('topics:open-terminal-with-command', { detail: { sessionKey: topic.sessionKey, command: 'claude' } })); } }
        : undefined;
      setCommandResult({ type: 'success', message: tr(refusedCli.answer.key, { name: refusedCli.name, close: shortcut('W') }), action });
      return true;
    }

    return false;
  }, [topic.sessionKey, topic.id, topic.provider, topic.projectPath, isGlobalOrchestrator, loadHistory, goal, declareGoal, closeGoal, confirm, sendMessage, getCompactionMarkers, tr, locale, forkHere, askSideQuestion, currentMessages, currentStreaming, handleExportConversation, setCommandResult, fastMode, onUpdateTopic, commandTitleRef, compactSaidRef, compactWatchRef, composerControlsRef, sendMessageRef, setCommandAnswer, setCommandLoading, toggleFastModeRef]);
}
