/** Topic and project navigation tools: move, switch, new topic, projects, resolve_tab. */
import { httpJson } from "./topics-http";
import type { ParsedArgs } from "./topics-http";

export async function callMoveToProject(
  args: ParsedArgs,
  toolArgs: { project_path?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.project_path !== "string" || !toolArgs.project_path) {
    throw new Error("move_session_to_project: 'project_path' (string) is required");
  }
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/move-to-project`;
  const body = await httpJson<{ ok?: boolean; paneId?: string; projectPath?: string }>(
    args, "POST", path, { projectPath: toolArgs.project_path }, fetchImpl,
  );
  return `moved ${body?.paneId ?? "tab"} into project ${body?.projectPath ?? toolArgs.project_path} (de-duplicated)`;
}

// --- Topic / project control bridge ----------------------------------------
export async function callSwitchTopic(
  args: ParsedArgs,
  toolArgs: { topic_id?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.topic_id !== "string" || !toolArgs.topic_id) {
    throw new Error("switch_topic: 'topic_id' (string) is required");
  }
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/switch-topic`;
  const body = await httpJson<{ toTopicId?: string }>(args, "POST", path, { topicId: toolArgs.topic_id }, fetchImpl);
  return `switched to topic ${body?.toTopicId ?? toolArgs.topic_id}`;
}

export async function callNewTopic(
  args: ParsedArgs,
  toolArgs: { title?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.title !== "string" || !toolArgs.title) {
    throw new Error("new_topic: 'title' (string) is required");
  }
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/new-topic`;
  const body = await httpJson<{ topicId?: string }>(args, "POST", path, { title: toolArgs.title }, fetchImpl);
  return `created + switched to new topic "${toolArgs.title}" (id=${body?.topicId ?? "?"})`;
}

export async function callCreateProject(
  args: ParsedArgs,
  toolArgs: { name?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.name !== "string" || !toolArgs.name) {
    throw new Error("create_project: 'name' (string) is required");
  }
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/create-project`;
  const body = await httpJson<{ projectPath?: string }>(args, "POST", path, { name: toolArgs.name }, fetchImpl);
  return `created + opened project at ${body?.projectPath ?? toolArgs.name}`;
}

export async function callOpenProject(
  args: ParsedArgs,
  toolArgs: { ref?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.ref !== "string" || !toolArgs.ref) {
    throw new Error("open_project: 'ref' (string) is required");
  }
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/open-project`;
  const body = await httpJson<{ projectPath?: string }>(args, "POST", path, { ref: toolArgs.ref }, fetchImpl);
  return `opened project at ${body?.projectPath ?? toolArgs.ref}`;
}

/**
 * Il sottoinsieme di `ResolvedTab` (server/lib/tab-resolver.ts) su cui questo
 * handler fa una guardia. Il corpo viene poi rigirato al modello tale e quale,
 * quindi non serve ricopiare qui l'intero tipo — e non lo si importa per la
 * stessa ragione delle altre righe qui sopra: questo processo vive dall'altra
 * parte di un confine di fiducia, senza un tsc che leghi le due parti.
 */
interface ResolveTabResp { kind?: unknown; state?: unknown }

/**
 * `GET /api/tabs/resolve` — da un permalink incollato dall'umano a «di quale tab
 * si parla e come se ne legge il contenuto». Un `ref` per chiamata, come la
 * rotta: l'alternativa (elencare tutte le tab) riverserebbe nel contesto url,
 * titoli e cwd di ogni finestra aperta.
 *
 * Un ref che la grammatica non riconosce è un 400 della rotta, che `httpJson`
 * trasforma in throw → il modello lo vede come tool error con il messaggio del
 * server («ref is not a tab permalink»), che è esattamente l'informazione utile.
 */
export async function callResolveTab(
  args: ParsedArgs,
  toolArgs: { ref?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.ref !== "string" || !toolArgs.ref.trim()) {
    throw new Error("resolve_tab: 'ref' (string) is required");
  }
  const path = `/api/tabs/resolve?ref=${encodeURIComponent(toolArgs.ref.trim())}`;
  const body = await httpJson<ResolveTabResp>(args, "GET", path, undefined, fetchImpl);
  if (!body || typeof body.kind !== "string") {
    throw new Error("resolve_tab: server did not return a resolved tab");
  }
  return JSON.stringify(body, null, 2);
}
