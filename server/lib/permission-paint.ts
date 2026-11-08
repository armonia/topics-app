/**
 * Su QUALE riga di chat va dipinto il pannello di permesso, e ci sta già?
 *
 * Estratta da `POST /api/sessions/:sessionKey/permission` (server/routes/topics.ts):
 * erano sessanta righe di politica — un ripiego per nome, una precedenza fra due
 * campi persistiti, un «nel dubbio ridipingi» — chiuse dentro un blocco di rotta
 * insieme alla query, al broadcast e al rendez-vous. Nessuna delle tre guardie
 * era esercitabile: per provarle serviva un permesso vero in volo. Qui dentro
 * non c'è né db né rete: entra la RIGA già letta, esce la decisione.
 *
 * Chi chiama resta responsabile degli effetti (l'alias, la scrittura, il frame WS).
 */

import { decodeCol } from "../../shared/message-blob";

/** L'ultima riga di `messages` per questa sessione, coi due campi che contano. */
export interface PermissionPaintRow {
  tool_calls?: string | null;
  blocks?: string | null;
}

export interface PermissionPaintDecision {
  /** L'id della riga su cui dipingere: `toolUseId`, o quello trovato per nome. */
  targetId: string;
  /**
   * Non-null quando il ripiego per nome ha spostato il bersaglio: la
   * corrispondenza `toolUseId → targetId` va SCRITTA (aliasPermission) prima di
   * mettersi in attesa, perché il click tornerà con l'id della riga, non con
   * quello che la CLI ci ha passato.
   */
  aliasTo: string | null;
  /** true = il pannello è già a schermo su `targetId`: non ridipingere. */
  alreadyPainted: boolean;
}

type ShownCall = { id?: string; name?: string; status?: string; permissionRequest?: unknown } | null;

/** Il primo elemento dell'array JSON il cui `pick` ha l'id cercato. */
function findPainted(
  raw: string | null | undefined,
  targetId: string,
  pick: (v: unknown) => ShownCall,
): ShownCall {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw) as unknown[];
    if (!Array.isArray(arr)) return null;
    for (const item of arr) {
      const tc = pick(item);
      if (tc?.id === targetId) return tc;
    }
  } catch {
    /* riga illeggibile */
  }
  return null;
}

/**
 * @param row       ultima riga persistita della sessione (o niente)
 * @param toolUseId il `tool_use_id` che la CLI ha passato con la richiesta
 * @param toolName  il nome dello strumento in attesa
 *
 * Tre guardie, e ognuna ha un caso che l'ha meritata:
 *
 * 1. **Ripiego per nome.** Se nessuna riga porta `toolUseId` — un id che Topics
 *    non ha persistito, o una CLI futura che smettesse di passarlo — si prende
 *    l'ULTIMA riga con quel nome ancora `running`/`pending`. Ultima, non prima:
 *    lo stesso strumento può comparire più volte nello stesso turno, e quella
 *    che aspetta è l'ultima. Una riga già `success`/`error` non aspetta più
 *    nessuno e non va toccata.
 *
 * 2. **I blocchi battono `tool_calls`.** «Già dipinto» si giudica sui `blocks`
 *    quando ci sono, perché sono quelli che il client legge per disegnare. Un
 *    `tool_calls` in ordine sopra dei blocchi fermi è esattamente il caso che
 *    lasciò una riga a girare per sempre sotto «in attesa della tua risposta»
 *    senza pannello. `tool_calls` resta il ripiego per le righe senza blocchi.
 *
 * 3. **Nel dubbio si ridipinge.** JSON illeggibile, campo assente, forma
 *    inattesa → `alreadyPainted:false`. Un pannello in più è visibile e si può
 *    correggere; uno in meno è una richiesta che nessuno vedrà mai.
 */
export function decidePermissionPaint(
  row: PermissionPaintRow | null | undefined,
  toolUseId: string,
  toolName: string,
): PermissionPaintDecision {
  let targetId = toolUseId;
  let aliasTo: string | null = null;
  let alreadyPainted = false;

  try {
    // Nessuna rete di protezione sulla FORMA: una `tool_calls` che non è un
    // array cade nel catch qui sotto, cioè in «ridipingi» — la stessa uscita
    // che aveva prima dell'estrazione.
    const calls = row?.tool_calls ? (JSON.parse(decodeCol(row.tool_calls) ?? "null") as { id?: string; name?: string; status?: string }[]) : [];
    if (!calls.some((c) => c?.id === toolUseId)) {
      const byName = [...calls]
        .reverse()
        .find((c) => c?.name === toolName && (c.status === "running" || c.status === "pending"));
      if (byName?.id) {
        targetId = byName.id;
        aliasTo = byName.id;
      }
    }

    const fromBlocks = findPainted(decodeCol(row?.blocks), targetId, (b) => {
      const bb = b as { kind?: string; toolCall?: { id?: string; status?: string; permissionRequest?: unknown } };
      return bb?.kind === "tool" ? bb.toolCall ?? null : null;
    });
    const shown = fromBlocks ?? findPainted(decodeCol(row?.tool_calls), targetId, (c) => c as ShownCall);
    alreadyPainted = shown?.status === "awaiting_permission" && !!shown?.permissionRequest;
  } catch {
    /* nel dubbio si ridipinge: un pannello in più è visibile, uno in meno no */
  }

  return { targetId, aliasTo, alreadyPainted };
}

/**
 * The tool NAME on the row, given the id of the call that was clicked. It is
 * what `allow_always` writes as the rule's pattern: no name, no rule.
 *
 * Same precedence as guard 2 above: `blocks` FIRST, then `tool_calls` as the
 * fallback for rows without blocks. Not a matter of style: since a row with
 * blocks writes `tool_calls` as `[]` (`toolCallsColumnForRow`,
 * shared/lean-tool-call.ts) the name lives ONLY in the blocks, and whoever
 * looked it up in the column found an empty array. The effect was an "always
 * allow" that allowed once: the rule was never written and the next request
 * reopened the panel, with no error anywhere.
 */
export function toolNameOnRow(row: PermissionPaintRow | null | undefined, toolCallId: string): string | null {
  const fromBlocks = findPainted(decodeCol(row?.blocks), toolCallId, (b) => {
    const bb = b as { kind?: string; toolCall?: { id?: string; name?: string } };
    return bb?.kind === "tool" ? bb.toolCall ?? null : null;
  });
  const found = fromBlocks ?? findPainted(decodeCol(row?.tool_calls), toolCallId, (c) => c as ShownCall);
  return typeof found?.name === "string" && found.name ? found.name : null;
}
