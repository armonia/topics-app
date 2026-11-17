/**
 * Usage store and the Claude session tracker, with the observers that keep chats and attention in step with the CLI.
 */
import { configureSessionParkingForTracker } from "../lib/session-parking";
import { configureNativeHistorySource } from "../providers/native/history-rehydrate";
import { nativeHistorySource } from "../providers/native/history-source";
import { getAgentPtyCliPids, getClaudeSessionPtyIdleMs } from "../routes/terminal";
import { initUsageStore, rebuildSummary } from "../usage/store";
import { configureSideCallLedger } from "../usage/side-calls";
import { tryGetProvider } from "../providers";
import { sessionAttentionBackground } from "../providers/background-probes";
import { ClaudeCodeProvider } from "../providers/claude-code";
import { commandWakeState, isChatServerTask, settleEndedShells } from "../routes/processes";
import { configureAttentionStore, getAttention, processEnded } from "../attention/store";
import { withCommandTask, withSubagentTask } from "../attention/background-tasks";
import { subagentWakeState } from "../lib/subagent-runtime";
import { observeSubagentWaitChanged } from "../lib/subagent-wait-events";
import { observeCommandChanged } from "../lib/command-background";
import { chatBackgroundChanged, chatSubjectOfSession } from "../attention/wire";
import { terminalSubject } from "../../shared/attention";
import { createClaudeSessionTracker } from "../lib/claude-session-tracker";
import { noticeOwedChanges, postBackgroundNotice } from "../lib/background-notice";
import type { AfterBrowser } from "./scope";

export function bootTracker(scope: AfterBrowser) {
  const { ctx, turnLedger } = scope;
  // Init usage tracking (still uses JSON files — will be migrated in a future phase)
  initUsageStore(ctx.STATE_DIR);

  // Side calls (titles, judges, commit messages) go to `usage_records`.
  configureSideCallLedger(ctx.db);

  // @covers BOOT-NONFATAL-01
  // `summary.json` è un file di COMODO: si ricostruisce dai giornalieri a ogni
  // avvio, e chi lo legge ha già la sua ricaduta. Farlo cadere qui significa che
  // un file cosmetico decide se l'app parte — ed è successo il 25/08: un ENOENT
  // sul rename di un temporaneo ha ucciso il server al boot, e 253 test di uno
  // shard non sono mai partiti. Si logga e si va avanti: il riassunto si
  // ricostruisce al giro dopo.
  try { rebuildSummary(); }
  catch (e) { console.error("[usage] rebuildSummary failed at boot (non-fatal):", e); }


  // Claude Code session tracker — canonical lifecycle state for every Claude
  // CLI session spawned via Topics (topic chats persist in the DB; topic-less
  // terminal sessions are tracked in-memory). Created before the terminal router
  // so the latter can register its sessions with it. See
  // openspec/changes/claude-session-tracker.
  const claudeSessionTracker = createClaudeSessionTracker({
    db: ctx.db,
    broadcast: ctx.broadcastToAll,
    ptyIdleMs: getClaudeSessionPtyIdleMs,
    // The attention subject of a session: its chat, or the terminal it runs in
    // (notifications-redesign). A session nobody owns keeps a subject of its own.
    attentionSubject: (s) => {
      if (s.sessionKey) return chatSubjectOfSession(s.sessionKey) ?? `session:${s.sessionKey}`;
      const terminalId = getAgentPtyCliPids().find((p) => p.claudeSessionId === s.claudeSessionId)?.sessionId
        ?? (ctx.db.query("SELECT id FROM terminal_sessions WHERE claude_session_id = ? LIMIT 1").get(s.claudeSessionId) as { id?: string } | null)?.id;
      return terminalId ? terminalSubject(terminalId) : `claude:${s.claudeSessionId}`;
    },
    // Message-import sink for ADOPTED sessions: the sweep reads the transcript
    // tail and appends the terminal's new turns into the topic's chat.
    importSink: {
      getLastMessageId: (sk) => {
        const thread = ctx.loadLocalMessages(sk, { withBlocks: false });
        return thread.length ? thread[thread.length - 1]!.id : null;
      },
      appendMessages: (sk, msgs) => ctx.appendImportedMessages(sk, msgs),
      resolveToolResult: (sk, toolUseId, result, isError) =>
        ctx.updateToolCallResult(sk, toolUseId, isError ? "" : result, isError ? result : undefined),
      topicIdForSessionKey: (sk) => ctx.getTopicBySessionKey(sk)?.id ?? null,
      // `topic:updated` is what an open pane reconciles its thread on
      // (usePanelLifecycle): the imported tool rows and results reach it too.
      announceThreadChanged: (sk) => {
        const topic = ctx.getTopicBySessionKey(sk);
        if (topic) ctx.broadcastToAll({ type: "topic:updated", topic });
      },
    },
    // Double-import guard: while Topics owns a live claude child for the session,
    // the chat provider streams + persists those turns itself.
    isSessionLocallyDriven: (sk) => {
      try {
        const p = tryGetProvider("claude-code") as unknown as { isTurnProcessAlive?: (s: string) => boolean } | undefined;
        return !!p?.isTurnProcessAlive?.(sk);
      } catch { return false; }
    },
  });


  // The other half of the double-import guard: `isSessionLocallyDriven` only
  // protects bytes the sweep sees mid-turn, so the moment a Topics-driven turn
  // ends the import cursor jumps past everything it wrote. Armed on the class,
  // like `observeWokenTurns`, because claude-code is not registered yet at boot.
  ClaudeCodeProvider.observeTurnReleased((sk) => { claudeSessionTracker.syncImportOffsetToEnd(sk); });

  // The CLI between a `system/init` and its `result`, whoever started the turn:
  // the ledger holds the session open for it (server/lib/turn-ledger.ts), so the
  // 409 gate and every window's queue see a turn the CLI opened by itself.
  ClaudeCodeProvider.observeCliTurns((sk, open) => { turnLedger.set(sk, "cli", open); });

  // A clock closed a CLI with background work still listed: the chat says what
  // died and why (server/lib/background-notice.ts), not only the log.
  ClaudeCodeProvider.observeBackgroundClosed((sessionKey, tasks, why, cron) => {
    const topic = ctx.getTopicBySessionKey(sessionKey);
    if (topic) postBackgroundNotice(ctx, { sessionKey, topicId: topic.id }, { kind: "background-notice", event: "closed", tasks, why, cron });
  });

  /**
   * A chat's task map for the attention state, rewritten whole: the CLI's
   * snapshot (or, when no provider can tell, what the map already held) with the
   * session's Topics commands folded in as one `command` task
   * (`withCommandTask`). The CLI's changes and the commands' go through here, so
   * neither drops the other's tasks.
   */
  function syncChatBackgroundTasks(sessionKey: string): void {
    const subject = chatSubjectOfSession(sessionKey);
    if (!subject) return;
    const work = sessionAttentionBackground(sessionKey);
    const base = work?.tasks ?? Object.fromEntries(getAttention(subject).background.map(({ id, ...t }) => [id, t]));
    const at = new Date().toISOString();
    const withCommands = withCommandTask(base, commandWakeState(sessionKey), at).tasks;
    chatBackgroundChanged(sessionKey, withSubagentTask(withCommands, subagentWakeState(sessionKey), at).tasks);
  }

  // A task listed or gone, a Monitor recognised: every window refetches the
  // status route now instead of at its next 15 s poll (BGVIS-06).
  ClaudeCodeProvider.observeBackgroundChanged((sessionKey) => {
    const topic = ctx.getTopicBySessionKey(sessionKey);
    if (topic) ctx.broadcastToAll({ type: "background:changed", topicId: topic.id, sessionKey });
    // A shell the CLI no longer lists may have exited: its row closes now, and a server's sign with it.
    void settleEndedShells(sessionKey);
    // The same change, for the attention state: the chat's task map is the CLI's snapshot.
    syncChatBackgroundTasks(sessionKey);
  });

  // A Topics command of a chat started or ended: the same map, with the command folded in.
  // A chat's server (a port seen or gone) goes through here too, and leaves or rejoins the map.
  observeCommandChanged(syncChatBackgroundTasks);
  // A sub-agent of a chat started, opened or closed a turn, ended, or left a result: the same map, with the children folded in (BGVIS-10).
  observeSubagentWaitChanged(syncChatBackgroundTasks);

  // A background Bash of a chat that listens on a port is its server, never a task it waits for (BGVIS-09).
  configureAttentionStore({ isServerTask: isChatServerTask });

  // The CLI is gone: what the chat waited on will never answer (ATTN-15). The
  // open turn is the route's to close, with the error it caught.
  ClaudeCodeProvider.observeProcessEnded((sessionKey, cause, byPerson) => {
    const subject = chatSubjectOfSession(sessionKey);
    if (subject) processEnded(subject, { cause, byPerson, turnClosedByRoute: true });
  });

  ClaudeCodeProvider.observeConfigOwed((sessionKey, changes) => {
    const topic = ctx.getTopicBySessionKey(sessionKey);
    if (topic) noticeOwedChanges(ctx, topic, "deferred-background", Object.fromEntries(changes.map((c) => [c, true])));
  });


  // La porta unica del parcheggio (lib/session-parking.ts): archiviare un topic
  // deve anche mettere a riposo la sua sessione, o la fase resta viva per sempre
  // su una chat che non ha più né riga né tab. Configurata qui perché il tracker
  // nasce DOPO il contesto; i tre percorsi di archiviazione la chiamano.
  configureSessionParkingForTracker(claudeSessionTracker);


  // Il runtime nativo tiene le conversazioni in una Map di processo e dichiara
  // alla rotta «la storia me la ricordo io» (`contextStrategy: inline-system`).
  // Vero finché il processo vive — e qui il processo si riavvia a ogni
  // salvataggio in `server/`. Da qui in poi, quando una sua sessione nasce, se la
  // va a riprendere dal DB: `loadActiveThread` è la stessa lettura che alimenta la
  // chat, quindi il modello riparte esattamente da ciò che l'utente ha davanti.
  // The tool calls travel too, and `withBlocks: true` is why: see
  // `history-source.ts` for the column that used to make this promise false.
  // `historyFromPersistedThread` caps the token cost of that history on its own
  // (`REHYDRATE_WINDOW_TOKENS`), so this file only has to supply it whole.
  configureNativeHistorySource((sessionKey) => nativeHistorySource(ctx, sessionKey));

  return { claudeSessionTracker };
}
