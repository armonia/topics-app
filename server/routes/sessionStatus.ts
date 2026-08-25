/**
 * What `/status` answers: the state of THIS session, in the order you would ask.
 *
 * WHY IT IS ITS OWN FILE. It was four lines inline in the `/api/command` route,
 * and inline meant untestable: the route loads messages and looks the topic up
 * from the global store, so exercising the text meant standing up both. The
 * same cut was made for the same reason in `routes/clearPolicy.ts` and
 * `routes/subagentProcesses.ts` — the decision moves to where a test can reach
 * it, the route keeps the plumbing.
 *
 * WHAT IT USED TO SAY, and why that was the wrong four things. Session key,
 * message count, project path, topic name. Three of those four the user can
 * already see: the topic name is in the tab, the project is in the sidebar, and
 * the session key is an internal identifier they did not ask about. Meanwhile
 * everything that actually decides how the next turn behaves — which model,
 * which reasoning effort, how much autonomy it has, whether it is in fast mode,
 * whether its MCP fleet is the full one or the reduced bridge — was absent,
 * even though every field sits on the same `topic` object the old version
 * already had in hand.
 *
 * That matters most exactly when a user types `/status`: they type it because
 * something behaved unexpectedly. "Why did it not touch my files" is answered
 * by the autonomy line; "why is it slower/dumber than yesterday" by the model
 * and effort lines; "why can it not see my MCP servers" by the fleet line.
 *
 * THE RULE FOR ADDING A LINE: it belongs here if it can explain a surprise. A
 * field the user can read off the screen does not qualify, no matter how easy
 * it is to include.
 */

/** The subset of a topic this report reads. Narrow on purpose: a wider type
 *  invites lines that answer nothing. */
export interface TopicPerStato {
  name?: string | null;
  projectPath?: string | null;
  model?: string | null;
  effort?: string | null;
  provider?: string | null;
  autonomyLevel?: string | null;
  fastMode?: boolean | null;
  mcpPolicy?: string | null;
  contextFiles?: unknown[] | null;
  worktreeId?: string | null;
}

/**
 * What each autonomy level MEANS for the next turn, in the words that answer
 * the question the user is really asking ("why did it not do the thing?").
 *
 * The strings themselves are Italian because they are USER-FACING output, not
 * comments: this report is read in the app, in the app's language.
 * allow-italian: these are the sentences shown to the user
 */
const AUTONOMIA: Record<string, string> = {
  ask: "propone e aspetta (non tocca file, non esegue comandi)",
  "auto-apply": "scrive sui file da sé, il resto lo propone",
  yolo: "fa tutto senza chiedere",
};

export interface StatoOpts {
  sessionKey: string;
  messaggi: number;
  topic: TopicPerStato | null | undefined;
  /** The model that would actually serve the next turn when the topic pins none. */
  modelloDiRipiego?: string | null;
}

/**
 * The `/status` report.
 *
 * Every line is conditional, and that is deliberate: a line saying "Effort:
 * none" teaches the reader nothing and pushes the lines that do matter further
 * down. An absent override IS the default, and the default is not news.
 */
export function statoSessione(o: StatoOpts): string {
  const t = o.topic;
  const righe: (string | null)[] = [
    t?.name ? `📝 Topic: ${t.name}` : null,
    t?.projectPath ? `📁 Progetto: ${t.projectPath}` : null,
    t?.worktreeId ? `🌿 Worktree: ${t.worktreeId}` : null,
    `💬 Messaggi: ${o.messaggi}`,

    // The four that decide how the next turn behaves. The model line names its
    // source, because "the topic pins opus" and "nothing is pinned and the
    // default happens to be opus" look identical on screen and are not the
    // same fact: only the first survives a change of the default.
    t?.model
      ? `🧠 Modello: ${t.model} (fissato su questo topic)`
      : o.modelloDiRipiego
        ? `🧠 Modello: ${o.modelloDiRipiego} (default, non fissato qui)`
        : null,
    t?.effort ? `⚡ Effort: ${t.effort}` : null,
    t?.fastMode ? "🏎️ Fast mode: acceso" : null,
    t?.autonomyLevel
      ? `🛡️ Autonomia: ${t.autonomyLevel} — ${AUTONOMIA[t.autonomyLevel] ?? "livello sconosciuto"}`
      : null,

    // Two that explain a missing capability rather than a behaviour.
    t?.mcpPolicy === "bridge-only"
      ? "🔌 MCP: solo il ponte `topics` (flotta ridotta, profilo di dispatch)"
      : null,
    t?.contextFiles?.length ? `📎 File di contesto: ${t.contextFiles.length}` : null,

    t?.provider ? `🤖 Provider: ${t.provider}` : null,
    // Last, and only here: an internal identifier is what you copy into a bug
    // report, not what you came to read.
    `📍 Sessione: ${o.sessionKey}`,
  ];
  return righe.filter(Boolean).join("\n");
}
