import { assembleTopicContext, composeSystemMessages, type ContextEnvelope } from "../context";
import { DEFAULT_CONTEXT_WINDOW } from "../usage/context-window";
import type { ChatMessage } from "../providers";
import type { ChatTurnScope } from "./chat-turn-scope";

/** Assembles the context envelope and the message list of a turn. */
export function assembleTurnContext(turn: ChatTurnScope): void {
  const { body, carried, ctx, lastUserMsg, matchedTopic, messages, planMode, sessionKey, turnUserContent } = turn;
  // ─── Canonical context envelope ─────────────────────────────────
  // Replaces the inline finalMessages assembly that used to live here
  // (≈140 lines of category-aware splice() calls). The envelope is the
  // single source of truth for what the model will see — both the
  // `streamEditResponse` send path AND the inspector preview consume
  // it via `assembleTopicContext`.
  //
  // Provider-specific shaping (history vs inline preamble) happens
  // later via `adaptEnvelope`, after we resolve the actual provider.
  // For now we use a placeholder strategy; the *system block contents*
  // and *history* are strategy-independent so the FS reads happen once.
  //
  // `includeLastUserInHistory: false` — the new user turn (just persisted
  // by appendLocalMessage above) is passed separately via
  // `payload.userContent`, not duplicated inside `payload.history`.
  const envelope: ContextEnvelope = matchedTopic
    ? assembleTopicContext(ctx, {
        sessionKey,
        providerName: "(pending)",
        providerStrategy: "history-aware",
        userMessageOverride: { content: turnUserContent, messageId: lastUserMsg?.id },
        includeLastUserInHistory: false,
        ...(carried.length > 0 ? { alsoInUserMessage: carried.map((c) => c.rowId) } : {}),
        planMode,
        // Per-turn flag OR topic-persisted preference — either opts in.
        // Mirrors the resolution logic for `fastModeActive` further down
        // (the route layer is the single authority on whether fast is on).
        fastMode: body.fastMode === true || matchedTopic.fastMode === true,
        // Lean envelope on a dispatcher resume/continuation (contextMode
        // "lean"), but ONLY when the session already has stored turns — a
        // resume onto an empty/lost conversation must re-ground with the
        // full envelope, not a bare role prompt.
        //
        // La soglia è `> 1`, non `> 0`, e non è un dettaglio: il turno
        // utente di QUESTA richiesta è già stato scritto in DB poco sopra
        // (`appendLocalMessage`, ~riga 279), quindi con `> 0` la
        // condizione era VERA sempre — anche su una conversazione persa,
        // che è esattamente il caso che questo guard doveva proteggere.
        // Il ramo «re-ground con l'inviluppo pieno» non è mai stato preso.
        //
        // E si conta, non si carica: `loadLocalMessages` ricostruisce
        // tutto il ramo attivo con blocks e tool_calls riparsati da JSON
        // (25 ms sulle sessioni agentiche grosse) — e `assembleTopicContext`
        // qui sotto lo rifà comunque per conto suo, quindi erano due
        // passate complete per rispondere a una domanda da COUNT.
        leanContext:
          body.contextMode === "lean" &&
          ((ctx.db
            .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_key = ?")
            .get(sessionKey) as { n: number } | undefined)?.n ?? 0) > 1,
      })
    : {
        // No topic bound to this sessionKey — emit a degenerate envelope
        // so the legacy HTTP fallback path still has *something* to
        // serialise. Mirrors the pre-refactor behaviour where
        // `if (matchedTopic)` skipped all the system block injection.
        topicId: "",
        sessionKey,
        providerName: "(pending)",
        providerStrategy: "history-aware",
        systemBlocks: [],
        history: messages
          .filter((m: any) => m.role === "user" || m.role === "assistant")
          .slice(0, -1)
          .map((m: any) => ({ role: m.role, content: m.content })),
        userMessage: { content: turnUserContent },
        diagnostics: {
          totalTokens: 0, budgetLimit: DEFAULT_CONTEXT_WINDOW, budgetPercent: 0,
          droppedHistoryTurns: 0, historyEntries: [],
          warnings: [], assembledAt: Date.now(),
        },
      };
  turn.envelope = envelope;

  // Build the legacy `finalMessages: { role; content }[]` array for the
  // HTTP fallback path further down. Composed from the envelope so the
  // shape matches what providers used to receive (system messages
  // followed by the full user/assistant transcript).
  const composedSystemMessages = composeSystemMessages(envelope.systemBlocks);
  const finalMessages: ChatMessage[] = [
    ...composedSystemMessages.map((m) => ({ role: m.role, content: m.content })),
    ...envelope.history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: envelope.userMessage.content },
  ];
  turn.finalMessages = finalMessages;
}
