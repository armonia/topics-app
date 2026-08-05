/**
 * «Questa chat sta aspettando TE» — letto dalla riga, non dalla memoria.
 *
 * Lo scatto che il client interroga per sapere chi sta lavorando distingue due
 * stati: `streaming` (l'agente macina) e `waiting` (la palla è dell'umano). Il
 * secondo lo ricavava da una sola fonte, `provider.pendingInputSince` — la
 * mappa in memoria del provider, che conosce le domande fatte con il canale
 * NATIVO della CLI. Le domande del pannello di Topics passano invece dal bridge
 * MCP: nessuna voce in quella mappa, quindi una chat ferma su
 * `ask_user_question` continuava a dirsi «sta lavorando» in sidebar e sulle
 * tab. E dopo un riavvio del server anche la mappa del bridge è vuota, mentre
 * il figlio la domanda ce l'ha ancora aperta.
 *
 * La riga invece se lo ricorda: un tool in `waiting_for_input` È la domanda a
 * schermo, ed è l'unica fonte che sopravvive a un riavvio. Qui la lettura,
 * pura, perché il resto sono due colonne di JSON.
 */

/** Quando è cominciata l'attesa, o `null` se nessuna domanda è a schermo. */
export function waitingAskStartedAt(
  toolCallsJson: string | null | undefined,
  blocksJson: string | null | undefined,
  fallbackNow?: number,
): number | null {
  const waiting = findWaiting(toolCallsJson) ?? findWaitingInBlocks(blocksJson);
  if (!waiting) return null;
  const started = typeof waiting.startedAt === "number" && Number.isFinite(waiting.startedAt) && waiting.startedAt > 0
    ? waiting.startedAt
    : null;
  // Senza timestamp l'attesa esiste comunque: dire «da adesso» sbaglia la
  // durata, tacere sbaglia lo STATO — e lo stato conta di più. Chi disegna
  // mostra "da poco" invece di un numero inventato all'indietro.
  return started ?? fallbackNow ?? null;
}

interface MaybeToolCall { name?: unknown; status?: unknown; startedAt?: unknown }

function isWaitingAsk(t: MaybeToolCall | null | undefined): t is { name: string; status: string; startedAt?: number } {
  if (!t || typeof t !== "object") return false;
  return t.status === "waiting_for_input";
}

function findWaiting(json: string | null | undefined): { startedAt?: number } | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    const hit = parsed.find(isWaitingAsk);
    return hit ? { startedAt: typeof hit.startedAt === "number" ? hit.startedAt : undefined } : null;
  } catch { return null; }
}

function findWaitingInBlocks(json: string | null | undefined): { startedAt?: number } | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    for (const b of parsed) {
      const tc = (b as { kind?: string; toolCall?: MaybeToolCall } | null)?.kind === "tool"
        ? (b as { toolCall?: MaybeToolCall }).toolCall
        : null;
      if (isWaitingAsk(tc)) return { startedAt: typeof tc.startedAt === "number" ? tc.startedAt : undefined };
    }
    return null;
  } catch { return null; }
}
