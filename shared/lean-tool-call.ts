/**
 * Il risultato di un tool viaggia DUE VOLTE nella stessa riga.
 *
 * `ToolCall.result` è il testo grezzo; `ToolCall.detail` è la versione tipata
 * costruita al confine del provider, e per i tool che restituiscono testo quel
 * testo ci finisce dentro tale e quale — `detail.output` per una shell,
 * `detail.content` per un Read, `detail.result` per un MCP. Il renderer legge
 * `detail` quando c'è ed è valido (`resolveToolDetail`,
 * client/src/components/Chat/toolDetail.ts:277) e `result` resta una copia che
 * nessuno guarda.
 *
 * Misurato sul DB di questa macchina, topic:6b99e9cf: 8,20 MB di payload per
 * 118 messaggi, di cui 2,48 MB sono questo duplicato — il 30%. Su 891 tool call
 * con `detail` e `result` entrambi presenti (612 shell, 247 read, 30 mcp, 2
 * monitor) la copia è IDENTICA byte a byte in tutti i casi; le uniche divergenze
 * sono i `write`, dove `result` è la conferma della scrittura e non il file, e
 * infatti restano intatti.
 *
 * È lo stesso difetto già tolto un livello più su — `blocks` e `tool_calls` che
 * portavano la stessa cosa (server/routes/history.ts) — solo dentro alla
 * toolCall invece che accanto.
 *
 * ## Perché è senza perdita
 *
 * Non c'è una tabella «per il tipo X togli il campo Y»: si toglie `result` solo
 * quando dentro `detail` esiste una stringa UGUALE, byte per byte. Se l'uguale
 * non c'è, `result` resta. Quindi il testo non sparisce mai dal payload: o è
 * ancora lì, o è già nel campo che il renderer legge davvero.
 *
 * L'altra metà della garanzia è a monte: il server valida `detail` con lo stesso
 * schema Zod del client (`sanitizeToolCallDetail`, server/utils.ts:67) e lo
 * SCARTA se non passa. Un `detail` che arriva al client è quindi un `detail` che
 * il client accetterà — il ripiego `deriveToolDetail(name, args, result)` si
 * attiva solo quando `detail` manca, e in quel caso qui non si tocca niente.
 */

/** Quanto in profondità cerchiamo la copia dentro `detail`. */
const MAX_DEPTH = 2;

/**
 * C'è, dentro `value`, una stringa identica a `needle`?
 *
 * Profondità limitata: le forme di `ToolCallDetail` mettono il testo o in un
 * campo di primo livello (`output`, `content`, `result`, `text`) o dentro `raw`
 * (il tipo `unknown`), cioè mai sotto il secondo livello. Il confronto fra
 * stringhe si ferma sulla lunghezza prima di leggere i byte, quindi scorrere i
 * campi costa quanto leggere le loro lunghezze.
 */
function containsSameString(value: unknown, needle: string, depth = 0): boolean {
  if (typeof value === 'string') return value === needle;
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return false;
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (containsSameString(v, needle, depth + 1)) return true;
  }
  return false;
}

/** La forma minima che serve qui: non importiamo `ToolCall` per non legare shared/ a un tipo che cambia spesso. */
type LeanableToolCall = { detail?: unknown; result?: unknown };

/**
 * La stessa toolCall senza il `result` duplicato, o l'originale identico
 * (stesso riferimento) quando non c'è niente da togliere.
 *
 * Tornare lo stesso oggetto quando non si tocca niente non è un dettaglio: chi
 * chiama può copiare il messaggio solo se qualcosa è cambiato davvero, e le
 * sessioni senza tool non pagano una riallocazione per riga.
 */
export function leanToolCall<T extends LeanableToolCall>(tc: T): T {
  if (!tc || typeof tc !== 'object') return tc;
  const { detail, result } = tc;
  if (typeof result !== 'string' || result.length === 0) return tc;
  if (detail === null || typeof detail !== 'object') return tc;
  if (!containsSameString(detail, result)) return tc;
  const { result: _duplicato, ...rest } = tc;
  return rest as T;
}

/**
 * `leanToolCall` su ogni elemento, preservando il riferimento all'array quando
 * nessun elemento è cambiato.
 */
export function leanToolCalls<T extends LeanableToolCall>(calls: readonly T[]): readonly T[] {
  let changed = false;
  const out = calls.map((tc) => {
    const lean = leanToolCall(tc);
    if (lean !== tc) changed = true;
    return lean;
  });
  return changed ? out : calls;
}

/** Un blocco della timeline che potrebbe portare una toolCall. */
type LeanableBlock = { toolCall?: LeanableToolCall } & Record<string, unknown>;

/** Il minimo di un messaggio che serve qui. */
type LeanableMessage = {
  partial?: boolean;
  blocks?: readonly LeanableBlock[];
  toolCalls?: readonly LeanableToolCall[];
};

/**
 * Un messaggio pronto per il filo: senza le DUE copie che il client non legge.
 *
 * 1. `toolCalls` accanto a `blocks`. Portano la stessa cosa e il renderer usa i
 *    blocchi — «When present and non-empty, [blocks] takes precedence over the
 *    legacy thinking/toolCalls/content bucket rendering»
 *    (client/src/components/MessageContent.tsx).
 * 2. `result` dentro ogni `toolCall`, quando `detail` porta già quel testo.
 *
 * Un messaggio PARZIALE esce intatto: è quello su cui lo streaming continua ad
 * applicare gli eventi dei tool (client/src/hooks/useChat.ts), e lì `toolCalls`
 * è ancora la lista che cresce e `result` il campo che si sta riempiendo.
 *
 * Vive qui, e non nel gestore di una rotta, perché le rotte che spediscono
 * messaggi sono più d'una: `/api/history/:key` la usa per la chat, e
 * `/api/topics/:id/messages` per gli agenti via MCP. Quando la sfoltita stava
 * dentro alla prima, la seconda spediva 12,5 MB dove la prima ne spediva 5,4.
 */
export function leanMessageForWire<T extends LeanableMessage>(m: T): T {
  if (!m || typeof m !== 'object' || m.partial) return m;
  const blocks = m.blocks?.length ? leanBlocks(m.blocks) : m.blocks;
  const dropToolCalls = !!m.blocks?.length && !!m.toolCalls?.length;
  if (blocks === m.blocks && !dropToolCalls) return m;
  return { ...m, blocks, ...(dropToolCalls ? { toolCalls: undefined } : {}) };
}

/** `leanMessageForWire` su una lista, preservando il riferimento se nulla cambia. */
export function leanMessagesForWire<T extends LeanableMessage>(msgs: readonly T[]): readonly T[] {
  let changed = false;
  const out = msgs.map((m) => {
    const lean = leanMessageForWire(m);
    if (lean !== m) changed = true;
    return lean;
  });
  return changed ? out : msgs;
}

/**
 * `leanToolCall` sulle toolCall annidate nei blocchi di un messaggio.
 * Stessa regola sul riferimento: array e blocchi intatti se non c'è niente da togliere.
 */
export function leanBlocks<T extends LeanableBlock>(blocks: readonly T[]): readonly T[] {
  let changed = false;
  const out = blocks.map((b) => {
    if (!b || typeof b !== 'object' || !b.toolCall) return b;
    const lean = leanToolCall(b.toolCall);
    if (lean === b.toolCall) return b;
    changed = true;
    return { ...b, toolCall: lean };
  });
  return changed ? out : blocks;
}
