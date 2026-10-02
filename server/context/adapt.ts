/**
 * `adaptEnvelope` — turns a canonical `ContextEnvelope` into a
 * provider-specific `ProviderPayload` ready for `provider.sendChat`.
 *
 * Behaviour MUST be byte-for-byte identical to the legacy inline path in
 * `server/routes/topics.ts:2517-2559` (and the system-message construction
 * at `server/routes/topics.ts:1593-1734`). The regression test in
 * `topics-route-payload.test.ts` (Section 8 of the change `topic-context-canonical`)
 * pins this contract.
 *
 * Three strategies, set per-provider via `provider.contextStrategy`:
 *   - `history-aware`     prepend system messages to history; pass userContent verbatim.
 *   - `inline-system`     concatenate system messages, wrap in `<context>...</context>`,
 *                         prepend to userContent; do NOT pass history (CLI session-resident).
 *   - `gateway-stateful`  same shape as history-aware, different `adaptationNotes`.
 */

import type { ChatMessage } from "../providers/types";
import type { ContextEnvelope, ProviderPayload, SystemBlock } from "./envelope";
import { hashSlot } from "./inline-sent-state";

// ────────────────────────────────────────────────────────────────────────────
// Slot taxonomy
// ────────────────────────────────────────────────────────────────────────────

/**
 * The unit of deduplication is the COMPOSED SLOT, not the `SystemBlock`.
 *
 * `composeSystemSlots` aggregates: every `file:*` ends up in a single message,
 * project-awareness + every `template:*` in another. Deduplicating per block
 * would mean re-emitting `Context files for this topic:` carrying only the file
 * that changed — a sentence that is FALSE against what the session already has.
 * The slot instead leaves whole, and stays coherent by construction.
 */
export type SystemSlotId =
  | "prompt"
  | "user-rules"
  | "skills"
  | "files"
  | "template"
  | "browser"
  | "project-markers"
  | "topic-switch"
  | "memory"
  | "pinned"
  | "goal"
  | "plan-mode"
  | "global-board";

export interface SystemSlot {
  slot: SystemSlotId;
  content: string;
}

/** Names for the retirement line, read by a model and not by a parser. */
const SLOT_LABELS: Record<SystemSlotId, string> = {
  prompt: "system prompt",
  "user-rules": "user rules",
  skills: "skills",
  files: "context files",
  template: "project files",
  browser: "browser instructions",
  "project-markers": "project controls",
  "topic-switch": "topic directory",
  memory: "memory",
  pinned: "pinned messages",
  goal: "goal",
  "plan-mode": "plan mode",
  "global-board": "global board snapshot",
};

/**
 * Slots that are NEVER deduplicated: they are current STATE, not a document.
 * Plan mode costs a few hundred tokens and is worth restating on every turn it
 * is active, rather than trusting the model to remember it.
 */
const VOLATILE_SLOTS: ReadonlySet<SystemSlotId> = new Set<SystemSlotId>(["plan-mode", "global-board"]);

/** Same estimate as the rest of the envelope (`SystemBlock.tokens`). */
function estimateTokens(text: string): number {
  return Math.round(text.length / 4);
}

/**
 * The CLI built-ins that must be delivered BARE, because the CLI parses them by
 * looking at the start of the message and any preamble in front hides them.
 *
 * It is an ALLOWLIST, not «starts with a slash»: that predicate also caught a
 * pasted path — `/Users/someone/…`, `/tmp to check` — and stripped all context
 * from that message. On a first turn, or right after a compaction, that meant a
 * whole turn with no idea which project the work is in.
 *
 * EVERY NAME HERE IS A COMMAND OF THE INSTALLED CLI, measured, and
 * `slashCommandRouting.test.ts` holds it to the list Claude Code 2.1.288 gives
 * in `--print` (its `init.slash_commands`, plus the aliases and the names it
 * refuses headless). Six names that no longer exist there (todos, todo,
 * install, migrate-installer, pr-comments, and Gemini's compress) used to sit
 * here: each travelled NAKED, without its context, and the CLI handed it to
 * the model as a paid turn. Out of the list they are ordinary messages again.
 *
 * The names the CLI REFUSES in `--print` (resume, login, export, …) stay on
 * purpose. The composer answers them locally (`cliRefused.ts`), and whatever
 * still gets here (a board card, an API caller) is refused by the CLI at $0
 * instead of becoming a paid prose turn behind a preamble.
 */
const CLI_BUILTINS = new Set([
  "compact", "clear", "cost", "context", "status", "model", "config", "doctor",
  "help", "init", "login", "logout", "memory", "resume", "review", "vim",
  "release-notes", "bug", "exit", "quit", "privacy-settings", "terminal-setup",
  "upgrade", "mcp", "agents", "hooks", "permissions", "usage", "export",
  "rewind", "sandbox", "statusline", "output-style", "add-dir", "ide",
  "security-review",
]);

/**
 * Runtimes that parse a leading slash themselves: the Claude Code CLI and the
 * ACP agents it shares the strategy with. The native engine (`topics`) is
 * `inline-system` too, but it has no slash parser: a naked `/compact` there
 * was a paid prose turn with no context at all.
 */
function parsesSlashCommands(providerName: string): boolean {
  return providerName !== "topics";
}

function isCliBuiltin(content: string): boolean {
  const t = content.trimStart();
  if (!t.startsWith("/")) return false;
  // The command is the first token, arguments aside: `/compact`, `/model opus`.
  // A path has a slash INSIDE the first token, so it cannot get through.
  const first = t.slice(1).split(/\s/, 1)[0] ?? "";
  if (!first || first.includes("/")) return false;
  return CLI_BUILTINS.has(first.toLowerCase());
}

/**
 * The command-name shape the CLI itself accepts (`looksLikeCommand` in Claude
 * Code 2.1.288: `/^[a-zA-Z0-9_][a-zA-Z0-9:_-]*$/`). A first token outside it
 * is never parsed as a command, so it can never be a skill invocation.
 */
const COMMAND_NAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9:_-]*$/;

/**
 * The skill (or custom command) named by a message, or null.
 *
 * Syntax alone is not enough, for the same reason as `CLI_BUILTINS`: «/tmp to
 * check» has a well-formed first token and is a pasted path. Only a name the
 * caller KNOWS to be a command counts (`isKnownSlashCommand` on disk); with no
 * predicate nothing does, and the message keeps today's shape.
 */
function slashInvocationName(content: string, isSlashCommand: ((name: string) => boolean) | undefined): string | null {
  if (!isSlashCommand) return null;
  // No trimStart here: the CLI tests `startsWith("/")` on the raw text, so a
  // message with leading blanks is prose to it whatever we do.
  if (!content.startsWith("/")) return null;
  const first = content.slice(1).split(/\s/, 1)[0] ?? "";
  if (!COMMAND_NAME_RE.test(first)) return null;
  return isSlashCommand(first) ? first : null;
}

/**
 * The providers that can carry the context NEXT TO a bare slash invocation
 * instead of in front of it:
 *  - `claude-code`: a stream-json user message whose content is two text
 *    blocks. The CLI parses the LAST block as the input and hands the blocks
 *    before it to the command as `precedingInputBlocks`, which it places in the
 *    meta message just before the expanded skill body. Read in the 2.1.288
 *    binary (`H=UIn(x),be=H===null?x:x.slice(0,-1)` then
 *    `processSlashCommand(H,be,...)`; the prompt command builds `[...be, ...body]`)
 *    and observed on a real run: `/probe alpha beta` expanded with
 *    `$ARGUMENTS` = «alpha beta» and the context block in front of the body.
 *  - `topics` (native): the API user message takes the same two blocks.
 * Any other inline-system provider (ACP agents) keeps the old prefix.
 */
const SLASH_SIDE_CHANNEL_PROVIDERS = new Set(["claude-code", "topics"]);

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

export interface AdaptOptions {
  /**
   * Slots the CLI session already owns, `slot → hash`. Read-only: this function
   * stays PURE — state comes in as an argument and leaves as
   * `payload.inlineSlots`. Persisting it is the caller's job.
   *
   * Absent or empty ⇒ no deduplication, i.e. the first turn of a session (and
   * that is why the byte-for-byte regression test still holds).
   */
  alreadySent?: ReadonlyMap<string, string>;
  /**
   * Whether `name` is a skill or custom command the provider will expand
   * (`/recap`, `/opsx:propose`). Injected so this function stays pure: the answer lives
   * on disk and depends on the topic's working directory. Absent ⇒ no message
   * is treated as a skill invocation.
   */
  isSlashCommand?: (name: string) => boolean;
}

/**
 * THE TWO BLOCKS ONLY THE NATIVE RUNTIME MUST RECEIVE.
 *
 * `claude` reads `~/.claude/CLAUDE.md` on its own and knows its own skills:
 * sending them means paying for the same text twice on every turn. The native
 * runtime talks to the API and has them nowhere.
 *
 * THE FILTER LIVES HERE, NOT IN `assembleTopicContext`, and the reason is a
 * mistake already made: the route assembles the envelope with
 * `providerName: "(pending)"` and resolves the provider AFTER, so a gate further
 * upstream switched the blocks off every time — they were in the inspector
 * preview and not in the message, i.e. the worst way to be wrong, because the
 * inspector claimed they were there.
 */
const NATIVE_ONLY_BLOCKS = new Set(["user:CLAUDE.md", "synthetic:skills"]);

export function adaptEnvelope(envelope: ContextEnvelope, opts?: AdaptOptions): ProviderPayload {
  const blocks = envelope.providerName === "topics"
    ? envelope.systemBlocks
    : envelope.systemBlocks.filter((b) => !NATIVE_ONLY_BLOCKS.has(b.id));
  const slots = composeSystemSlots(blocks);
  const composedSystem = slots.map((s) => sys(s.content));

  switch (envelope.providerStrategy) {
    case "history-aware":
      return adaptHistoryAware(envelope, composedSystem);
    case "inline-system":
      return adaptInlineSystem(envelope, slots, opts?.alreadySent, opts?.isSlashCommand);
    case "gateway-stateful":
      return adaptGatewayStateful(envelope, composedSystem);
    default: {
      // Exhaustiveness guard. If a new strategy is added without updating
      // this switch, TypeScript will surface the unhandled case here.
      const _exhaustive: never = envelope.providerStrategy;
      throw new Error(`Unknown provider strategy: ${_exhaustive}`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Strategy implementations
// ────────────────────────────────────────────────────────────────────────────

function adaptHistoryAware(
  envelope: ContextEnvelope,
  composedSystem: ChatMessage[],
): ProviderPayload {
  return {
    userContent: envelope.userMessage.content,
    history: [...composedSystem, ...envelope.history],
    adaptationNotes: buildHistoryAwareNotes(envelope, composedSystem.length),
  };
}

/**
 * Invio DIFFERENZIALE del preambolo.
 *
 * La CLI è process-resident: quello che le abbiamo già detto è ancora nella sua
 * conversazione. Riemetterlo non aggiunge informazione — appende byte identici a
 * un contesto che ogni chiamata successiva rilegge per intero, e il costo è
 * COMPOSTO: i ~2k token appesi al turno 12 li ripaga ogni richiesta dalla 13 in
 * poi. Su una chat reale (topic "quadra", 33 turni, 663 risposte) erano 23,35M
 * token su 146,5M, cioè il 15,9% della sessione, per ripetere trentadue volte un
 * README che non era cambiato.
 *
 * Quindi uno slot parte se e solo se il suo contenuto è cambiato — l'hash decide.
 * Niente si perde (CLAUDE.md modificato a metà sessione riparte), niente si ripete.
 */
function adaptInlineSystem(
  envelope: ContextEnvelope,
  slots: SystemSlot[],
  alreadySent: ReadonlyMap<string, string> | undefined,
  isSlashCommand: ((name: string) => boolean) | undefined,
): ProviderPayload {
  // Un comando built-in della CLI va consegnato NUDO. `/compact` & co. li parsa
  // la CLI guardando l'inizio del messaggio: qualunque cosa messa davanti — anche
  // un preambolo legittimo — glielo nasconde, e il comando finisce al modello, che
  // risponde "`/compact` non esiste" e si fa pagare un turno mentre il contesto
  // continua a crescere. Il bottone "compatta" nasce proprio quando la finestra si
  // sta riempiendo, cioè nel momento in cui sbagliarlo costa di più.
  //
  // Gli slot NON vengono marcati (inlineSlots resta assente): quello che è
  // cambiato parte al turno successivo, che e' un messaggio normale.
  if (parsesSlashCommands(envelope.providerName) && isCliBuiltin(envelope.userMessage.content)) {
    return {
      userContent: envelope.userMessage.content,
      adaptationNotes: [
        "Slash command: sent verbatim, no <context> preamble (the CLI parses built-ins at the start of the message)",
      ],
    };
  }

  const emitted: SystemSlot[] = [];
  const skipped: SystemSlotId[] = [];
  const inlineSlots: { slot: string; hash: string }[] = [];
  let savedTokens = 0;

  for (const s of slots) {
    const hash = hashSlot(s.content);
    // `inlineSlots` è lo stato RISULTANTE, non "cosa ho appena emesso": uno slot
    // saltato resta in sessione eccome, ed è proprio il motivo per cui va
    // riportato — altrimenti il turno dopo lo rimanderemmo.
    inlineSlots.push({ slot: s.slot, hash });
    if (!VOLATILE_SLOTS.has(s.slot) && alreadySent?.get(s.slot) === hash) {
      skipped.push(s.slot);
      savedTokens += estimateTokens(s.content);
      continue;
    }
    emitted.push(s);
  }

  // Uno slot SPARITO è informazione: senza dirlo, il modello resta a credere di
  // essere in plan mode dopo che l'utente l'ha spento. Il ritiro esce una volta
  // sola — lo slot lascia `inlineSlots`, quindi al turno dopo non è più "sparito".
  const present = new Set<string>(slots.map((s) => s.slot));
  const withdrawn = [...(alreadySent?.keys() ?? [])].filter((k) => !present.has(k));

  const parts: string[] = [];
  if (withdrawn.length > 0) {
    const labels = withdrawn.map((k) => SLOT_LABELS[k as SystemSlotId] ?? k);
    parts.push(`Context no longer in effect: ${labels.join(", ")}.`);
  }
  parts.push(...emitted.map((s) => s.content));

  let userContent = envelope.userMessage.content;
  const notes = buildInlineSystemNotes(envelope, emitted.length, skipped, savedTokens, withdrawn);
  // Niente da dire ⇒ il messaggio utente NUDO, senza un `<context></context>`
  // vuoto. È il caso a regime, ed è ciò che rende un turno "riaccedi" tre token
  // invece di millenovecentosettantatré.
  if (parts.length > 0) {
    const preamble = `<context>\n${parts.join("\n\n---\n\n")}\n</context>`;
    // A SKILL INVOCATION STAYS BARE. With the preamble in front, the CLI reads
    // `<context>…/recap` as prose and the skill never expands; moving it AFTER
    // the command makes it the skill's `$ARGUMENTS`, substituted inline in the
    // skill body. So it travels beside the message, never inside it: the slots
    // are still marked, because the context does reach the session.
    const skill = SLASH_SIDE_CHANNEL_PROVIDERS.has(envelope.providerName)
      ? slashInvocationName(userContent, isSlashCommand)
      : null;
    if (skill) {
      notes.unshift(`Skill invocation /${skill}: message sent bare, <context> delivered as a separate content block before it`);
      return { userContent, slashContext: preamble, adaptationNotes: notes, inlineSlots };
    }
    userContent = `${preamble}\n\n${userContent}`;
  }

  return {
    userContent,
    // No `history` field — process-resident CLI keeps its own session state.
    adaptationNotes: notes,
    inlineSlots,
  };
}

function adaptGatewayStateful(
  envelope: ContextEnvelope,
  composedSystem: ChatMessage[],
): ProviderPayload {
  return {
    userContent: envelope.userMessage.content,
    history: [...composedSystem, ...envelope.history],
    adaptationNotes: buildGatewayStatefulNotes(envelope, composedSystem.length),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// composeSystemMessages — granular blocks → aggregated system messages
// ────────────────────────────────────────────────────────────────────────────

/**
 * Aggregates `envelope.systemBlocks` into the same set of `system` messages
 * that `streamEditResponse` produced inline pre-refactor.
 *
 * Order (preserved across providers, mirrors the splice order in topics.ts):
 *   1. `prompt:system`
 *   2. `file:*` aggregated under `Context files for this topic:`
 *   3. project template aggregated (`template:project-awareness` + `template:NAME`)
 *   4. `synthetic:browser-instruction`
 *   5. `synthetic:project-markers`
 *   6. `synthetic:topic-switch-directory`
 *   7. `memory:topic`
 *   8. `pinned:messages` aggregated under "Pinned messages from this conversation"
 *   9. `synthetic:plan-mode`
 *
 * Disabled blocks are skipped. Informational blocks (`injectedByTopicsApp: false`)
 * are skipped — they're surfaced for inspector visibility only.
 */
export function composeSystemMessages(blocks: SystemBlock[]): ChatMessage[] {
  return composeSystemSlots(blocks).map((s) => sys(s.content));
}

/**
 * La stessa aggregazione di `composeSystemMessages`, con l'id dello slot accanto
 * al contenuto. È la forma che serve alla deduplicazione inline; l'altra resta
 * come wrapper per i chiamanti (e per la regressione byte-per-byte) che vogliono
 * solo i `ChatMessage`.
 */
export function composeSystemSlots(blocks: SystemBlock[]): SystemSlot[] {
  const enabled = blocks.filter((b) => b.enabled && b.injectedByTopicsApp);
  const messages: SystemSlot[] = [];
  const push = (slot: SystemSlotId, content: string) => messages.push({ slot, content });

  // ── 1. System prompt ──
  const prompt = enabled.find((b) => b.id === "prompt:system");
  if (prompt) push("prompt", prompt.content);

  // ── 1b. Regole globali dell'utente + elenco skill (solo runtime nativo) ──
  // Slot loro, non dentro `template`: quello si chiama «Project file» e queste
  // due cose non vengono dal progetto. Dedup normale: sono documenti, non stato.
  const userRules = enabled.find((b) => b.id === "user:CLAUDE.md");
  if (userRules) {
    push("user-rules",
      `The user's global instructions, from ~/.claude/CLAUDE.md. They apply to every task and override defaults:\n\n${userRules.content}`);
  }
  const skills = enabled.find((b) => b.id === "synthetic:skills");
  if (skills) push("skills", skills.content);

  // ── 2. Context files (aggregated) ──
  const files = enabled.filter((b) => b.category === "file");
  if (files.length > 0) {
    const parts = files.map((f) => `--- File: ${f.label} ---\n${f.content}`);
    push("files", `Context files for this topic:\n\n${parts.join("\n\n")}`);
  }

  // ── 3. Project template (aggregated) ──
  const aware = enabled.find((b) => b.id === "template:project-awareness");
  const tmplFiles = enabled.filter(
    (b) => b.category === "template"
      && b.id !== "template:project-awareness"
      && b.id !== "user:CLAUDE.md",
  );
  if (aware) {
    let content = aware.content;
    if (tmplFiles.length > 0) {
      const parts = tmplFiles.map((t) => `--- Project file: ${t.label} ---\n${t.content}`);
      content += `\n\nProject context files:\n\n${parts.join("\n\n")}`;
    } else if (aware.adapterHints?.projectListing) {
      // Fallback: shallow root listing — only when there are no template files
      // available (or all of them were toggled off). Mirrors legacy behaviour.
      content += `\n\nProject root files: ${aware.adapterHints.projectListing}`;
    }
    push("template", content);
  }

  // ── 4. Browser instruction ──
  const browser = enabled.find((b) => b.id === "synthetic:browser-instruction");
  if (browser) push("browser", browser.content);

  // ── 5. Project markers ──
  const projectMarkers = enabled.find((b) => b.id === "synthetic:project-markers");
  if (projectMarkers) push("project-markers", projectMarkers.content);

  // ── 6. Topic switch directory ──
  const topicSwitch = enabled.find((b) => b.id === "synthetic:topic-switch-directory");
  if (topicSwitch) push("topic-switch", topicSwitch.content);

  // ── 7. Memory (the topic's own; the global one is retired) ──
  const topicMem = enabled.find((b) => b.id === "memory:topic");
  if (topicMem) {
    push(
      "memory",
      `\n\n## Memory\nThe following memories/notes have been saved for context:\n\n### Topic Memory\n${topicMem.content.trim()}`,
    );
  }

  // ── 8. Pinned messages ──
  const pinned = enabled.find((b) => b.id === "pinned:messages");
  if (pinned) {
    push("pinned", `Pinned messages from this conversation (important context):\n\n${pinned.content}`);
  }

  // ── 9. Goal ──
  // `assemble.ts` lo produce (`pushGoalBlock`, id `synthetic:goal`) con
  // `injectedByTopicsApp: true` e `countInBudget: true` — l'ispettore lo mostra
  // e lo conta nel budget — ma fino a questa change nessuno degli slot lo
  // raccoglieva, quindi veniva scartato in silenzio e il modello non vedeva MAI
  // l'obiettivo del topic. Bug preesistente, non introdotto dalla dedup.
  //
  // ONE slot for two blocks that never coexist: with an active goal the goal
  // goes, without one the line that tells the agent how to declare it
  // (`synthetic:goal-hint`). A second slot would exist only never to be filled
  // alongside the first, and the dedup treats them the same anyway: the content
  // changes the moment a goal appears, so the slot re-sends itself.
  const goal = enabled.find((b) => b.id === "synthetic:goal")
    ?? enabled.find((b) => b.id === "synthetic:goal-hint");
  if (goal) push("goal", goal.content);

  // ── 10. Plan mode ──
  const plan = enabled.find((b) => b.id === "synthetic:plan-mode");
  if (plan) push("plan-mode", plan.content);

  // Fresh SQLite board state for the one registry-backed coordinator. It gets
  // its own volatile slot so an inline CLI session never suppresses a new (or
  // coincidentally same-hash) snapshot as if it were a static document.
  const globalBoard = enabled.find((b) => b.id === "synthetic:global-board-snapshot");
  if (globalBoard) push("global-board", globalBoard.content);

  return messages;
}

// ────────────────────────────────────────────────────────────────────────────
// Adaptation notes (inspector text)
// ────────────────────────────────────────────────────────────────────────────

function buildHistoryAwareNotes(envelope: ContextEnvelope, composedCount: number): string[] {
  const notes: string[] = [];
  notes.push(
    `${composedCount} aggregated system message(s) prepended to history (from ${countEmittedBlocks(envelope)} enabled source block(s))`,
  );
  notes.push(`${envelope.history.length} historic turn(s) included (after marker strip + limit)`);
  if (envelope.diagnostics.droppedHistoryTurns > 0) {
    notes.push(`${envelope.diagnostics.droppedHistoryTurns} older turn(s) dropped due to history limit`);
  }
  return notes;
}

function buildInlineSystemNotes(
  envelope: ContextEnvelope,
  composedCount: number,
  skipped: SystemSlotId[],
  savedTokens: number,
  withdrawn: string[],
): string[] {
  const notes: string[] = [];
  notes.push(
    `${composedCount} aggregated system message(s) inlined into user turn as <context> preamble (from ${countEmittedBlocks(envelope)} enabled source block(s))`,
  );
  // Il salto va DICHIARATO: un preambolo che sparisce senza spiegazione, in un
  // pannello che si chiama "ispettore", è indistinguibile da un bug.
  if (skipped.length > 0) {
    const labels = skipped.map((s) => SLOT_LABELS[s] ?? s).join(", ");
    notes.push(
      `${skipped.length} slot already in the CLI session, skipped (~${savedTokens.toLocaleString()} tokens saved): ${labels}`,
    );
  }
  if (withdrawn.length > 0) {
    const labels = withdrawn.map((s) => SLOT_LABELS[s as SystemSlotId] ?? s).join(", ");
    notes.push(`${withdrawn.length} slot withdrawn, declared no longer in effect: ${labels}`);
  }
  notes.push(
    `Provider does NOT receive the history field. The CLI session preserves prior turns process-side.`,
  );
  notes.push(
    `Inspector History tab reflects the topics-app DB; the live CLI session may have additional state from --resume`,
  );
  return notes;
}

function buildGatewayStatefulNotes(envelope: ContextEnvelope, composedCount: number): string[] {
  const notes: string[] = [];
  notes.push(
    `${composedCount} aggregated system message(s) sent as fallback (from ${countEmittedBlocks(envelope)} enabled source block(s))`,
  );
  notes.push(
    `Gateway typically uses internal session state and may ignore the history field on the happy path`,
  );
  notes.push(
    `History is sent so the gateway can rehydrate after process restart or session expiry`,
  );
  return notes;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function sys(content: string): ChatMessage {
  return { role: "system", content };
}

function countEmittedBlocks(envelope: ContextEnvelope): number {
  return envelope.systemBlocks.filter((b) => b.enabled && b.injectedByTopicsApp).length;
}
