/**
 * Canonical Topic Context Envelope
 * --------------------------------
 *
 * Single source of truth for "what context does a topic have, right now, for
 * provider X". Both the chat streaming path (`streamEditResponse` in
 * `server/routes/topics.ts`) and the inspector preview endpoint
 * (`/api/topics/:id/context-preview`) MUST derive their data from the same
 * `assembleTopicContext()` function — there are NO independent reconstructions
 * elsewhere in the codebase.
 *
 * See `openspec/changes/topic-context-canonical/design.md` for the rationale,
 * algorithm, and migration plan.
 *
 * This file contains **only types**. The implementation lives in:
 *   - `server/context/assemble.ts`        — `assembleTopicContext()`
 *   - `server/context/adapt.ts`           — `adaptEnvelope()`
 *   - `server/context/snapshots.ts`       — in-memory ring buffer
 *   - `server/context/provider-strategy.ts` — registry helper
 */

// La FORMA dell'envelope sta in shared/context-envelope.ts: la legge anche il
// client, che fino al 29/07 se l'era riscritta a mano tipo per tipo (`Envelope*`
// in client/src/lib/api.ts). Qui restano solo i re-export storici, così i ~40
// import da "./envelope" (o da "./context") non cambiano.
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { ProviderPayload as SharedProviderPayload } from "../../shared/context-envelope";

export type {
  SystemBlock,
  HistoryExcludeReason,
  HistoryEntryDiagnostic,
  ContextDiagnostics,
  ContextEnvelope,
} from "../../shared/context-envelope";
export type { ProviderContextStrategy } from "../../shared/types";

/**
 * Il payload per il provider, con i tool TIPATI: `Tool` è dell'SDK Anthropic,
 * che è una dipendenza del solo server. Il client legge lo stesso tipo con il
 * default `unknown` — non li renderizza, quindi non gli serve saperne di più.
 */
export type ProviderPayload = SharedProviderPayload<Tool>;
