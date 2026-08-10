/**
 * Quale provider decide la rotta di uno slash command.
 *
 * `/model`, `/effort` e `/reasoning` si biforcano sul provider: openclaw li
 * inoltra al gateway (`POST /api/inference/chat`), claude-code invece li
 * persiste come flag di spawn sul topic. La biforcazione va fatta sul provider
 * **dichiarato** dal topic, non su quello *risolto*.
 *
 * Non sono la stessa cosa. Chi risolve un provider deve pur restituire un
 * oggetto con cui parlare, quindi se il nome dichiarato non è registrato su
 * questa macchina ripiega sul default. Ed è lì che nasceva il difetto: un
 * runner CI non ha la CLI `claude`, quindi il provider `claude-code` non viene
 * mai registrato, il default diventa `openclaw`, e un `/model` su un topic
 * dichiarato claude-code partiva verso `127.0.0.1:18789` — dove non c'è nessun
 * gateway. Il server rispondeva 500 «Command failed: Unable to connect. Is the
 * computer able to access the url?», e la stessa spec era verde in locale (dove
 * `claude` c'è) e rossa in CI. Un topic non cambia natura perché su questa
 * macchina manca un binario.
 *
 * Il nome dichiarato non dipende da cosa è installato, quindi non mente. La
 * regola sta qui, pura e testata, perché il ripiego che la rompeva era proprio
 * il tipo di cosa che un `catch {}` fa sparire senza lasciare traccia.
 */

/**
 * Il provider DICHIARATO da un topic, senza fallback sul registro.
 *
 * @param topicProvider  `topic.provider` (null/undefined = topic senza provider esplicito)
 * @param defaultProviderName  il default del server, usato solo se il topic non dichiara nulla
 */
export function declaredProviderName(
  topicProvider: string | null | undefined,
  defaultProviderName?: string | null,
): string | undefined {
  const declared = topicProvider?.trim();
  if (declared) {
    // Coercizione legacy: i topic Master nascevano con "claude-code-team", che
    // non è un provider di chat registrato. È la stessa mappatura che fa
    // resolveProvider — vedi change refactor-master-into-kanban (AD-1).
    return declared === "claude-code-team" ? "claude-code" : declared;
  }
  return defaultProviderName?.trim() || undefined;
}

/**
 * Vero quando lo slash command va inoltrato al gateway OpenClaw invece di
 * essere persistito sul topic.
 */
export function routesThroughGateway(
  topicProvider: string | null | undefined,
  defaultProviderName?: string | null,
): boolean {
  return declaredProviderName(topicProvider, defaultProviderName) === "openclaw";
}
