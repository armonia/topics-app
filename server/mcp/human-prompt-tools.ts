/** Tools that block on a human: ask_user_question and the approval_prompt permission channel. */
import { httpJson } from "./topics-http";
import type { ParsedArgs } from "./topics-http";
import { sleep } from "./bridge-shared";
import { existsSync } from "node:fs";
import { askImagePath, questionImageRefs } from "../../shared/ask-images";

/**
 * How long ONE poll leg may block server-side. We send it rather than let the
 * server choose because it's OUR socket that dies: 25s is comfortably under any
 * default idle timeout, and the server clamps whatever we ask for.
 */
export const ASK_LEG_MS = 25_000;
/**
 * Per quanto si continua a ritentare quando il server non risponde.
 *
 * Era un CONTEGGIO — cinque tentativi, che con il backoff qui sotto fanno
 * 15,5 secondi — e quel numero era più corto di un riavvio del server. Il caso
 * reale: qualcuno salva un file sotto `server/`, il watcher fa un hot-reload
 * graceful, e fra SIGTERM, finestra di grazia dei provider, rilancio e boot
 * passano tranquillamente venti secondi. La domanda a schermo moriva lì —
 * «lost contact with topics-app» — pur avendo un figlio vivo dall'altra parte
 * e un umano che stava ancora leggendo.
 *
 * A budget in TIME instead of attempts: 90 seconds cover a slow restart with
 * margin. The rendez-vous recreates itself on the first leg that succeeds, so
 * retrying is all it takes. The server's answer buffer (`ASK_BUFFER_TTL_MS`)
 * waits longer than this plus one leg, so an answer given while the bridge was
 * retrying is still here when it comes back (tested).
 */
export const ASK_TRANSPORT_GRACE_MS = 90_000;
/** Backoff fra un ritentativo e l'altro (ms). Cresce, poi si stabilizza. */
export const ASK_RETRY_BACKOFF_MS = [500, 1000, 2000, 4000, 5000];
/**
 * ANTI-SPIN ceiling, not the life of the question.
 *
 * Only the SERVER ends a question (it answers `cancelled`), and a question has
 * no lifetime. This number exists only so a wedged loop cannot spin here
 * forever, so it must sit ABOVE the CLI's own patience with this call
 * (`MCP_TOOL_TIMEOUT` = `ASK_TRANSPORT_CEILING_MS`, 2^31 - 1 ms, ~24.8 days):
 * below it, this loop would be what ends a question, with the wrong message
 * ("gave up after N poll legs"). 100,000 legs of 25 s are ~29 days. It was
 * 5,000 (~34 h) while the server still closed questions at 24 h. The invariant
 * is tested in `topics-mcp-server.test.ts`.
 */
export const ASK_MAX_LEGS = 100_000;


interface AskLegResponse {
  answers?: Record<string, string>;
  metadata?: unknown;
  pending?: boolean;
  cancelled?: boolean;
  reason?: string;
}

/**
 * Ask the human a multiple-choice question in the chat and BLOCK until they
 * answer. Unlike every other bridge tool, this one POLLS: the CLI is blocked on
 * our JSON-RPC response, and the answer may take minutes (it's a human), but a
 * single HTTP request held open with zero bytes flowing is exactly what an idle
 * socket timeout kills — and it dies on THIS side, so the server can't save it.
 * That's not theory: the first live question died after minutes with a socket
 * connection error. So we send short legs; each returns `{pending:true}` while
 * the panel is still on screen and we come straight back. Whether the question
 * is still open is decided server-side, so polling can't keep a dead one alive.
 *
 * Transport failures are retried with backoff rather than surfaced: a dropped
 * socket must not cancel a question the human is still looking at.
 *
 * The returned JSON string is the answers map the model reads — mirroring the
 * built-in AskUserQuestion result shape (`{answers, metadata?}`), so a model
 * that has seen the real tool reads it the same way.
 */
export async function callAskUserQuestion(
  args: ParsedArgs,
  toolArgs: { questions?: unknown },
  fetchImpl: typeof fetch = fetch,
  /** Retry/backoff knobs — overridden by tests so they don't sleep for real. */
  opts: {
    backoffMs?: number[];
    maxLegs?: number;
    legMs?: number;
    /** Finestra di grazia per i guasti di trasporto (ms). I test la accorciano. */
    transportGraceMs?: number;
    /** Orologio iniettabile: i test misurano la finestra senza dormirci dentro. */
    now?: () => number;
    /**
     * Called once per leg while nobody has answered yet. In production this
     * emits `notifications/progress`, which is what stops the MCP client from
     * timing the call out under a question the human is still reading.
     */
    onProgress?: (leg: number) => void;
  } = {},
): Promise<string> {
  const backoff = opts.backoffMs ?? ASK_RETRY_BACKOFF_MS;
  const transportGraceMs = opts.transportGraceMs ?? ASK_TRANSPORT_GRACE_MS;
  const now = opts.now ?? Date.now;
  const maxLegs = opts.maxLegs ?? ASK_MAX_LEGS;
  const legMs = opts.legMs ?? ASK_LEG_MS;
  if (!Array.isArray(toolArgs?.questions) || toolArgs.questions.length === 0) {
    throw new Error("ask_user_question: 'questions' (non-empty array) is required");
  }
  // A picture that is not on disk is refused HERE, by name: the panel would
  // otherwise show a broken square and the person could not choose by looking.
  for (const ref of questionImageRefs(toolArgs.questions as Parameters<typeof questionImageRefs>[0])) {
    if (!existsSync(askImagePath(ref))) {
      throw new Error(`ask_user_question: image not found: ${ref}. Write the file first (an absolute path to an existing image) and ask again`);
    }
  }
  // Shape validation is intentionally light here — the server-side detector
  // (ask-user-detector.ts) is the single source of truth for clamping options,
  // dropping malformed questions, and the raw fallback. We just forward.
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/ask-user`;
  const payload = { questions: toolArgs.questions, legMs };

  // Quando è cominciata la serie di guasti IN CORSO (`null` = si sta parlando).
  // Il conteggio serve solo a scegliere il backoff; a decidere quando arrendersi
  // è il tempo, perché è il tempo la cosa che un riavvio del server consuma.
  let transportFailures = 0;
  let firstFailureAt: number | null = null;
  for (let leg = 0; leg < maxLegs; leg++) {
    let body: AskLegResponse | null | undefined;
    try {
      // NB: the cancelled signal uses `reason`, NOT `error` — httpJson
      // auto-throws on a top-level `error` field, which would bypass the clean
      // message below.
      body = await httpJson<AskLegResponse>(args, "POST", path, payload, fetchImpl);
      transportFailures = 0;
      firstFailureAt = null;
    } catch (err) {
      // Could be a dropped socket (retry — the panel is still up) or a real
      // server rejection (give up once we've clearly exhausted the benefit of
      // the doubt). We can't reliably tell them apart through httpJson, so we
      // bound the retries and report the last error if they run out.
      transportFailures++;
      if (firstFailureAt === null) firstFailureAt = now();
      const downMs = now() - firstFailureAt;
      if (downMs > transportGraceMs) {
        throw new Error(
          `ask_user_question: lost contact with topics-app for ${Math.round(downMs / 1000)}s over ${transportFailures} attempts (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      await sleep(backoff[Math.min(transportFailures - 1, backoff.length - 1)] ?? 0);
      continue;
    }

    if (!body) throw new Error("ask_user_question: empty response from topics-app");
    if (body.cancelled) {
      throw new Error(`ask_user_question: cancelled before the human answered${body.reason ? ` (${body.reason})` : ""}`);
    }
    if (body.pending) {
      // Nobody has answered yet. Say so OUT LOUD: silence is what the client
      // reads as a hung tool, and 25s of it is the only currency that buys the
      // question more time.
      opts.onProgress?.(leg + 1);
      continue; // next leg
    }
    return JSON.stringify({
      answers: body.answers ?? {},
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
    });
  }
  throw new Error(`ask_user_question: gave up after ${maxLegs} poll legs without an answer`);
}

/**
 * Tetto anti-giro-a-vuoto del permesso, con lo stesso ragionamento di
 * `ASK_MAX_LEGS`: chi decide che una richiesta è finita è il SERVER (risponde
 * `cancelled`), questo numero serve solo perché un server incastrato non faccia
 * girare qui un ciclo eterno. Deve stare COMODAMENTE SOPRA
 * `PERMISSION_TTL_MS / ASK_LEG_MS` — 2 h / 25 s = 288 gambe — o sarebbe lui, e
 * non il server, a decidere che un permesso muore, per giunta col messaggio
 * sbagliato. L'invariante è provata in `topics-mcp-server.test.ts`.
 */
export const PERMISSION_MAX_LEGS = 600;

interface PermissionLegResponse {
  decision?: "allow" | "allow_always" | "deny";
  pending?: boolean;
  cancelled?: boolean;
  reason?: string;
}

/**
 * Above this size the input is NOT echoed back in `updatedInput`.
 *
 * The permission answer is an MCP result like any other, so it is capped by
 * `MAX_MCP_OUTPUT_TOKENS`, which Topics lowers to 4,000 (~16 kB, see
 * `resolveMcpOutputTokens`). Over the cap the CLI moves the result to a file and
 * leaves a pointer: the text block is no longer the decision JSON, and the CLI
 * rejects the tool with "Permission prompt tool returned an invalid result".
 * Measured on 23/09 with CLI 2.1.280: `Workflow` carries the whole `script` in
 * its input (21 kB in the adopted session ca699d37) and every launch died this
 * way; 43 kB passes with the default cap and dies with ours.
 *
 * Without `updatedInput` the CLI runs the tool with the input it already had
 * (verified on the same version), and we never modify it, so nothing is lost.
 * Below the threshold the answer is unchanged, so older CLIs keep receiving
 * exactly what already worked for them.
 */
export const PERMISSION_ECHO_MAX_BYTES = 8 * 1024;

/** Il payload che la CLI si aspetta come `content[0].text`. */
function permissionPayload(decision: "allow" | "allow_always" | "deny", input: unknown, message: string): string {
  if (decision === "deny") return JSON.stringify({ behavior: "deny", message });
  const echoed = JSON.stringify({ behavior: "allow", updatedInput: input ?? {} });
  return Buffer.byteLength(echoed, "utf8") <= PERMISSION_ECHO_MAX_BYTES
    ? echoed
    : JSON.stringify({ behavior: "allow" });
}

/**
 * Il canale di permesso, lato bridge.
 *
 * ── La regola che governa ogni ramo di questa funzione ──────────────────────
 * TORNA SEMPRE UNA DECISIONE. Mai un throw. Un throw qui significa «lo
 * strumento di prompt è esploso», e la CLI lo traduce comunque in un rifiuto —
 * ma con un messaggio che parla del bridge invece che del permesso, cioè il
 * genere di errore che manda a cercare il guasto dalla parte sbagliata. Un
 * `deny` con scritto PERCHÉ è più corto da leggere e più onesto.
 *
 * Il giro è quello della domanda (gambe di poll, stessa ragione: la CLI si
 * blocca sulla risposta JSON-RPC e una richiesta HTTP tenuta aperta a zero byte
 * muore per timeout di socket dal lato del client).
 */
export async function callApprovalPrompt(
  args: ParsedArgs,
  toolArgs: { tool_name?: unknown; input?: unknown; tool_use_id?: unknown },
  fetchImpl: typeof fetch = fetch,
  opts: {
    maxLegs?: number;
    legMs?: number;
    transportGraceMs?: number;
    backoffMs?: number[];
    now?: () => number;
    onProgress?: (leg: number) => void;
  } = {},
): Promise<string> {
  const toolName = typeof toolArgs?.tool_name === "string" ? toolArgs.tool_name : "";
  const input = toolArgs?.input ?? {};
  // `tool_use_id` c'è sulla 2.1.224 (verificato). Se un giorno sparisse, il
  // server sa comunque agganciare il pannello all'ultima riga di tool con quel
  // nome — vedi la rotta. Qui basta una chiave stabile per questa chiamata.
  const toolUseId = typeof toolArgs?.tool_use_id === "string" && toolArgs.tool_use_id
    ? toolArgs.tool_use_id
    : `noid:${toolName}`;

  if (!toolName) {
    return permissionPayload("deny", input, "permesso: richiesta senza nome dello strumento");
  }

  const backoff = opts.backoffMs ?? ASK_RETRY_BACKOFF_MS;
  const transportGraceMs = opts.transportGraceMs ?? ASK_TRANSPORT_GRACE_MS;
  const now = opts.now ?? Date.now;
  const maxLegs = opts.maxLegs ?? PERMISSION_MAX_LEGS;
  const legMs = opts.legMs ?? ASK_LEG_MS;
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/permission`;
  const payload = { toolName, input, toolUseId, legMs };

  let transportFailures = 0;
  let firstFailureAt: number | null = null;

  for (let leg = 0; leg < maxLegs; leg++) {
    let body: PermissionLegResponse | null | undefined;
    try {
      body = await httpJson<PermissionLegResponse>(args, "POST", path, payload, fetchImpl);
      transportFailures = 0;
      firstFailureAt = null;
    } catch {
      transportFailures++;
      if (firstFailureAt === null) firstFailureAt = now();
      const downMs = now() - firstFailureAt;
      if (downMs > transportGraceMs) {
        // Topics non risponde da un minuto e mezzo: un hot-reload lungo è già
        // coperto dalla grazia, quindi qui è successo qualcosa di vero. Niente
        // sì per inerzia — un permesso che nessuno può negare non è un permesso.
        return permissionPayload(
          "deny",
          input,
          `permesso: Topics non risponde da ${Math.round(downMs / 1000)}s, nessuno ha potuto decidere`,
        );
      }
      await sleep(backoff[Math.min(transportFailures - 1, backoff.length - 1)] ?? 0);
      continue;
    }

    if (!body) return permissionPayload("deny", input, "permesso: risposta vuota da Topics");
    if (body.cancelled) {
      return permissionPayload("deny", input, body.reason || "permesso: richiesta annullata");
    }
    if (body.pending) {
      // Nessuno ha ancora premuto. Dirlo AD ALTA VOCE: il silenzio è ciò che il
      // client legge come tool piantato, ed è l'unica moneta con cui questa
      // richiesta compra altro tempo.
      opts.onProgress?.(leg + 1);
      continue;
    }
    if (body.decision === "allow" || body.decision === "allow_always") {
      return permissionPayload(body.decision, input, "");
    }
    return permissionPayload("deny", input, body.reason || `permesso negato per ${toolName}`);
  }
  return permissionPayload("deny", input, `permesso: nessuna risposta dopo ${maxLegs} gambe di poll`);
}
