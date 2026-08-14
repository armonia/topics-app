/**
 * Quali agenti ACP conosciamo, e come si lanciano.
 *
 * È una TABELLA, non del codice: è il punto del 3.2. Aggiungere un agente che
 * parla Agent Client Protocol deve costare una riga qui — non un provider
 * nuovo con il suo parser, la sua macchina a stati e i suoi bug. Oggi Topics
 * ha tre agenti cablati a mano; la lista sotto è il costo marginale del
 * quarto.
 *
 * Nessuna riga è inventata: ci sta solo un agente di cui conosciamo la riga di
 * comando. Tutto il resto passa da `ACP_AGENTS`, che è esattamente il caso
 * d'uso di chi ne ha uno che noi non abbiamo mai visto.
 */

export interface AcpAgentSpec {
  /** Nome del provider nel registro (`getProvider("gemini")`). */
  name: string;
  /** Eseguibile, risolto nel PATH se non è un percorso assoluto. */
  command: string;
  args: string[];
  /** Variabili extra, sopra l'allowlist. */
  env?: Record<string, string>;
}

/**
 * Gemini CLI espone ACP dietro `--acp` — è la stessa strada che usa Zed per
 * parlarci. Fino alla 0.5x il flag si chiamava `--experimental-acp`, che ora è
 * deprecato ma ancora accettato: se qui gira una CLI più vecchia del rename,
 * la riga si corregge da `ACP_AGENTS` senza toccare il codice.
 */
export const KNOWN_ACP_AGENTS: readonly AcpAgentSpec[] = [
  { name: "gemini", command: "gemini", args: ["--acp"] },
];

/**
 * Gli agenti dichiarati a mano in `ACP_AGENTS` (JSON array).
 *
 * Volutamente indulgente su ciò che accetta e severo su ciò che restituisce:
 * una variabile d'ambiente malformata NON deve impedire al server di partire,
 * quindi si scartano le voci illeggibili e si va avanti. Il chiamante logga
 * quante ne ha scartate.
 */
export function parseAcpAgentsEnv(raw: string | undefined): {
  agents: AcpAgentSpec[];
  skipped: number;
} {
  if (!raw || !raw.trim()) return { agents: [], skipped: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { agents: [], skipped: 1 };
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const agents: AcpAgentSpec[] = [];
  let skipped = 0;
  for (const entry of list) {
    const spec = coerceAgentSpec(entry);
    if (spec) agents.push(spec);
    else skipped++;
  }
  return { agents, skipped };
}

function coerceAgentSpec(entry: unknown): AcpAgentSpec | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const e = entry as Record<string, unknown>;
  const command = typeof e.command === "string" ? e.command.trim() : "";
  if (!command) return null;
  // Senza nome esplicito si usa il basename del comando: `~/bin/goose` → `goose`.
  const rawName = typeof e.name === "string" ? e.name.trim() : "";
  const name = (rawName || command.split("/").pop() || "").trim();
  if (!name) return null;
  const args = Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === "string") : [];
  const env = plainStringRecord(e.env);
  return { name, command, args, ...(env ? { env } : {}) };
}

function plainStringRecord(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * La lista finale: i noti + quelli dichiarati, con i secondi che VINCONO sui
 * primi a parità di nome. Chi scrive `ACP_AGENTS` sta correggendo la nostra
 * tabella, non aggiungendo un doppione da ignorare.
 */
export function mergeAcpAgents(
  known: readonly AcpAgentSpec[],
  declared: readonly AcpAgentSpec[],
): AcpAgentSpec[] {
  const byName = new Map<string, AcpAgentSpec>();
  for (const spec of known) byName.set(spec.name, spec);
  for (const spec of declared) byName.set(spec.name, spec);
  return [...byName.values()];
}
