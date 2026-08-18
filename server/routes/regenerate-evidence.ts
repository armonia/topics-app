/**
 * RIGENERA NON HA LE MANI, E VA DETTO AL MODELLO.
 *
 * `POST /api/messages/:id/regenerate` e `…/edit` non parlano con la sessione
 * residente: chiamano `streamHTTP`/`complete`, che sono stateless. E `complete()`
 * gira senza strumenti su ENTRAMBI i runtime — la CLI passa `--tools ""`
 * (providers/claude/args.ts:397), il nativo passa `tools: []`
 * (native/provider.ts:349). È una scelta giusta: quel percorso serve anche
 * all'auto-naming e ai digest, dove gli strumenti sarebbero solo peso.
 *
 * Il guaio è che il PROMPT non lo sa. L'inviluppo del topic descrive al modello
 * il progetto, il browser, i tool: gli si dice «hai Bash» e poi gli si tolgono le
 * mani. Misurato il 2026-08-18 su topic:9fe7a291: il modello ha scritto le
 * chiamate come TESTO letterale (`<invoke name="Bash">…</invoke>` dentro
 * `content`) e si è inventato gli output («Non nessuna mail di Giovanni trovata
 * in quel range»). Prosa sicura, comandi plausibili, risultati mai eseguiti:
 * `tool_calls` vuoto e la sessione ferma. È il modo peggiore di sbagliare,
 * perché SEMBRA lavoro.
 *
 * Qui si costruisce il pezzo di prompt che chiude il buco, e fa due cose
 * insieme:
 *
 * 1. **Dichiara il vincolo.** «In questo passaggio non hai strumenti» — così il
 *    modello non ha motivo di recitarli.
 * 2. **Dà le prove vere.** Le tool call del turno che si sta riscrivendo sono
 *    già registrate sulla riga (`messages.tool_calls`): nomi, argomenti, esiti.
 *    Passarle trasforma «rigenera» in «riscrivi la stessa risposta dalle stesse
 *    misure», che è l'unica semantica che regge su un turno agentico — rifare le
 *    parole senza rifare gli effetti collaterali.
 *
 * Senza il punto 2 il punto 1 da solo rende Rigenera onesto ma inutile: un
 * modello senza mani e senza dati può solo dire che non può misurare.
 */

/** Ciò che serve di una `ToolCall` per raccontarla come prova. */
export interface EvidenceToolCall {
  name?: string;
  args?: Record<string, unknown>;
  status?: string;
  result?: string;
  error?: string;
}

export interface EvidenceLimits {
  /** Quante chiamate al massimo. Oltre, si dice quante ne restano fuori. */
  maxCalls?: number;
  /** Taglio per argomenti ed esito, in caratteri. */
  maxChars?: number;
}

/**
 * I tetti sono tarati su una prova vera, non a occhio. Con `maxChars: 1200` il
 * primo test dal vivo — «quanti file di test ci sono sotto server/lib?», un
 * `wc -l` da 85 righe — arrivava al modello tagliato dopo il quattordicesimo
 * file, e la risposta rigenerata ha potuto elencarne solo quattordici. Onesta
 * (lo ha DETTO che i dati finivano lì, invece di inventarli, che è il punto di
 * tutto questo) ma dimezzata. 4000 caratteri tengono un output di quella taglia;
 * venti azioni al massimo perché oltre non è più una riscrittura, è un turno
 * nuovo — e per quello esiste il messaggio nuovo.
 */
const DEFAULTS: Required<EvidenceLimits> = { maxCalls: 20, maxChars: 4000 };

/**
 * Il vincolo, sempre. Vale anche quando di prove non ce n'è: un turno di sola
 * prosa non ha tool call, ma il preambolo del topic gli ha comunque descritto
 * gli strumenti.
 */
export const NO_TOOLS_NOTICE =
  "In questo passaggio NON hai strumenti: non puoi eseguire comandi, leggere file, " +
  "navigare o chiamare altri agenti. Riscrivi la risposta usando SOLO ciò che " +
  "trovi qui. Se qualcosa non c'è, dillo apertamente invece di ricavarlo o " +
  "stimarlo, e non scrivere mai una chiamata a uno strumento come se l'avessi " +
  "eseguita.";

function clip(value: string, maxChars: number): string {
  const s = value.replace(/\r/g, "");
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}\n… [troncato: ${s.length - maxChars} caratteri in più]`;
}

function describeArgs(args: Record<string, unknown> | undefined, maxChars: number): string | null {
  if (!args || typeof args !== "object") return null;
  const keys = Object.keys(args);
  if (keys.length === 0) return null;
  // La forma comoda: se c'è un solo campo, si stampa nudo — un comando bash o un
  // percorso si legge molto meglio senza le graffe intorno.
  if (keys.length === 1) {
    const only = args[keys[0]];
    const text = typeof only === "string" ? only : JSON.stringify(only);
    return clip(`${keys[0]}: ${text ?? ""}`, maxChars);
  }
  try { return clip(JSON.stringify(args), maxChars); } catch { return null; }
}

/**
 * Le prove del turno che si sta riscrivendo, o `null` se non ce ne sono.
 *
 * `null` NON significa «niente da dire»: il vincolo (`NO_TOOLS_NOTICE`) va
 * aggiunto lo stesso. Sono due cose separate apposta.
 */
export function formatRegenerationEvidence(
  calls: readonly EvidenceToolCall[] | null | undefined,
  limits?: EvidenceLimits,
): string | null {
  if (!calls || calls.length === 0) return null;
  const { maxCalls, maxChars } = { ...DEFAULTS, ...limits };
  const shown = calls.slice(0, maxCalls);
  const lines: string[] = [];
  shown.forEach((call, i) => {
    const name = call.name?.trim() || "(strumento senza nome)";
    // L'ESITO SI DICHIARA SEMPRE, anche quando manca. Una chiamata senza esito
    // registrato non è una chiamata riuscita: lasciarla muta inviterebbe a
    // riempirla d'immaginazione, che è esattamente il guasto da cui nasce
    // questo file.
    let outcome: string;
    if (call.error) outcome = `ERRORE: ${clip(call.error, maxChars)}`;
    else if (typeof call.result === "string" && call.result.length > 0) outcome = clip(call.result, maxChars);
    else outcome = "(nessun esito registrato: NON dare per scontato che sia andata bene)";
    lines.push(`${i + 1}. ${name}${call.status ? ` [${call.status}]` : ""}`);
    const args = describeArgs(call.args, maxChars);
    if (args) lines.push(`   ingresso: ${args.replace(/\n/g, "\n   ")}`);
    lines.push(`   esito: ${outcome.replace(/\n/g, "\n   ")}`);
  });
  // NIENTE TAGLI MUTI: se qualcosa resta fuori si dice, altrimenti «ecco le
  // prove» si legge come «ecco TUTTE le prove».
  if (calls.length > shown.length) {
    lines.push(`… e altre ${calls.length - shown.length} azioni non riportate qui.`);
  }
  return `Misure già raccolte dal turno che stai riscrivendo (${calls.length} azioni):\n${lines.join("\n")}`;
}

/**
 * Il blocco completo da appendere al prompt: vincolo, più le prove se ci sono.
 * Torna sempre una stringa — il vincolo non è opzionale.
 */
export function regenerationPromptBlock(
  calls: readonly EvidenceToolCall[] | null | undefined,
  limits?: EvidenceLimits,
): string {
  const evidence = formatRegenerationEvidence(calls, limits);
  return evidence ? `${NO_TOOLS_NOTICE}\n\n${evidence}` : NO_TOOLS_NOTICE;
}
