/**
 * The sub-agent processes of a topic, derived from a provider's session list.
 *
 * WHY THIS IS ITS OWN FILE. It used to be one long inline expression inside
 * `GET /api/processes` (`routes/topics.ts`), and that route is the only view
 * Topics has of sub-agents AS PROCESSES — the panel that says what is running
 * under a chat. Nothing tested it, and nothing could: the route resolves its
 * provider from the global registry, so exercising the mapping meant standing
 * up a fake provider. The same cut was made for the same reason in
 * `routes/clearPolicy.ts` — the decision is pure, so it lives where a test can
 * reach it and the route keeps only the plumbing.
 *
 * WHAT THE MAPPING DECIDES, and why each part can be wrong quietly:
 *
 *  - WHICH sessions count. A provider's session list contains far more than
 *    sub-agents; only the ones whose key names them belong in this panel. Get
 *    the filter wrong in the permissive direction and the panel fills with
 *    every session the provider knows — which reads as "these are all running
 *    under your chat", and none of them are.
 *  - WHETHER one is still running. `active` is the only status that means
 *    running; everything else is done. The panel draws a spinner off this, so
 *    an unknown status treated as running spins forever.
 *  - WHEN it finished. `completedAt` exists only for what has finished. A
 *    completion time on a running process is not a cosmetic slip: it is the
 *    panel saying a thing both ran and ended.
 */

/** One entry of a provider's session list, in the shape this mapping needs. */
export interface SessionePerProcessi {
  sessionKey?: string;
  label?: string | null;
  status?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface ProcessoSubagente {
  sessionKey: string;
  label: string;
  status: "running" | "done";
  startedAt: string;
  completedAt?: string;
}

/** Il segno che una sessione E' un sotto-agente, nella sua chiave. */
const MARCA_SUBAGENTE = "subagent";

/**
 * Le sessioni di sotto-agente, nella forma che il pannello disegna.
 *
 * `adesso` è un parametro e non `new Date()` di proposito: è il ripiego per le
 * date mancanti, e un test che non può fissarlo asserirebbe sull'orologio.
 */
export function processiSubagente(
  sessioni: readonly SessionePerProcessi[],
  adesso: () => string = () => new Date().toISOString(),
): ProcessoSubagente[] {
  return sessioni
    .filter((s) => s.sessionKey?.includes(MARCA_SUBAGENTE))
    .map((s) => {
      const chiave = s.sessionKey!;
      const attivo = s.status === "active";
      return {
        sessionKey: chiave,
        // Il ripiego è l'ULTIMO segmento della chiave, non la chiave intera:
        // `topic:abc:subagent:explore` in un pannello stretto deve leggersi
        // «explore». L'ultimo ripiego è una parola, mai una stringa vuota.
        label: s.label || chiave.split(":").pop() || "Sub-agent",
        status: attivo ? "running" : "done",
        startedAt: s.createdAt || adesso(),
        ...(attivo ? {} : { completedAt: s.updatedAt || adesso() }),
      };
    });
}
