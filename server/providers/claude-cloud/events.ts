// Traduce gli eventi di una sessione cloud nei callback di StreamHandler, così la
// vista chat di Topics li mostra come una sessione locale. Funzione pura sullo stato
// del turno: niente rete, niente orologio, quindi si prova con eventi registrati.

import type { StreamHandler } from "../types";
import type { CloudEvent } from "./api";

export interface TurnState {
  text: string;
  /** tool_use già annunciati, per non ripeterli se la pagina ritorna */
  tools: Set<string>;
  /** control_request già girati a Topics */
  asked: Set<string>;
  /** ramo consegnato (da `code_change_published`) */
  deliveredBranch?: string;
  deliveredUrl?: string;
  done: boolean;
}

export function newTurnState(): TurnState {
  return { text: "", tools: new Set(), asked: new Set(), done: false };
}

/** Un permesso chiesto dalla sessione: Topics risponde con CloudApi.respondPermission. */
export interface PermissionAsk {
  requestId: string;
  toolName: string;
  input: unknown;
}

export function applyEvent(
  ev: CloudEvent,
  st: TurnState,
  h: Pick<StreamHandler, "onTextDelta" | "onToolStart" | "onToolResult" | "onDone" | "onError"> &
    Partial<Pick<StreamHandler, "onThinkingDelta">>,
  onPermission?: (ask: PermissionAsk) => void,
): void {
  switch (ev.type) {
    case "assistant": {
      // Gli eventi dei sottoagenti hanno parent_tool_use_id: non sono il testo del turno.
      if (ev.parent_tool_use_id) return;
      const content = (ev.message as { content?: unknown[] } | undefined)?.content ?? [];
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string") {
          const delta = (st.text ? "\n\n" : "") + block.text;
          st.text += delta;
          h.onTextDelta(delta, st.text);
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          h.onThinkingDelta?.(block.thinking);
        } else if (block.type === "tool_use" && typeof block.id === "string" && !st.tools.has(block.id)) {
          st.tools.add(block.id);
          h.onToolStart(block.id, String(block.name ?? "tool"), (block.input ?? {}) as Record<string, unknown>);
        }
      }
      return;
    }
    case "user": {
      if (ev.parent_tool_use_id) return;
      const content = (ev.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) return;
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const raw = block.content;
        const text = typeof raw === "string"
          ? raw
          : Array.isArray(raw)
            ? raw.map((p) => (typeof p === "object" && p && "text" in p ? String((p as { text: unknown }).text) : "")).join("")
            : "";
        h.onToolResult(block.tool_use_id, text, block.is_error === true);
      }
      return;
    }
    case "control_request": {
      const id = String(ev.request_id ?? "");
      if (!id || st.asked.has(id)) return;
      st.asked.add(id);
      const req = (ev.request ?? {}) as { tool_name?: string; input?: unknown };
      onPermission?.({ requestId: id, toolName: req.tool_name ?? "tool", input: req.input });
      return;
    }
    case "system": {
      if (ev.subtype === "code_change_published" && typeof ev.branch === "string") {
        st.deliveredBranch = ev.branch;
        if (typeof ev.url === "string") st.deliveredUrl = ev.url;
      }
      return;
    }
    case "result": {
      if (st.done) return;
      st.done = true;
      if (ev.subtype === "success") {
        h.onDone({
          result: typeof ev.result === "string" ? ev.result : st.text,
          durationMs: typeof ev.duration_ms === "number" ? ev.duration_ms : undefined,
          costUsd: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : undefined,
          raw: ev,
        });
      } else {
        h.onError(`sessione cloud: turno finito con ${ev.subtype ?? "errore"}`);
      }
      return;
    }
    default:
      return; // env_manager_log, rate_limit_event, task_*: per ora non servono alla chat
  }
}
