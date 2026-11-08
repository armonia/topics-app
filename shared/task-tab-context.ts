/**
 * Gli identificativi delle tab possedute da un task — coniati dal server,
 * riconosciuti dal client, quindi scritti UNA volta sola qui invece che a
 * specchio nei due alberi.
 *
 * Un contextId di una tab del task è di tre forme, e nessuna può collidere con
 * le altre:
 *
 *   task-<id8>-<seq>        la tab aperta dal CLIENT (il "+" del drawer). <seq>
 *                           è un numero, quindi non è mai `a…` né `n…`.
 *   task-<id8>-a<topic8>    la tab senza nome di un AGENTE: una per (task,
 *                           topic), che ri-naviga a ogni `open_browser_pane`.
 *   task-<id8>-n<slug>      una tab del MANIFESTO: `open_browser_pane({url,
 *                           name})`. Un nome ⇒ una tab; riusare il nome
 *                           ri-naviga quella, un nome nuovo ne aggiunge una.
 *
 * E poi c'è il GEMELLO NEL WORKSPACE, `<ctx>_ws`: quando una tab del task viene
 * promossa nella finestra del progetto, la pane che la ospita là NON riusa il
 * contextId della tab. Sono due viste, e su Tauri una webview nativa ha un solo
 * genitore: due pane sullo stesso id si contenderebbero posizione e visibilità
 * della stessa view. Il gemello ha quindi una sua view — e, siccome `_ws` non è
 * producibile da nessuno slug (`[a-z0-9-]`, mai con trattino finale) né da un
 * seq numerico né da un id esadecimale, la derivazione è reversibile: da lì
 * `taskTabContextIdOf` risale alla tab, ed è così che il gemello eredita il suo
 * login salvato.
 */

/** Suffisso della pane che ospita una tab del task nel workspace del progetto. */
export const WORKSPACE_TWIN_SUFFIX = "_ws";

/**
 * Normalizza il nome di una tab in un pezzo di contextId: minuscolo, solo
 * `[a-z0-9-]`, senza trattini doppi o ai bordi, max 32 caratteri. Vuoto (o
 * fatto di soli simboli) torna `""` → il chiamante ricade sulla tab di default,
 * invece di coniare un id degenere che collezionerebbe tutte le tab senza nome
 * vero in una sola.
 */
export function slugTabName(name: unknown): string {
  if (typeof name !== "string") return "";
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

/** Il contextId della tab di un task: per NOME quando c'è, altrimenti l'unica
 *  tab senza nome di quell'agente. Vedi le tre forme in cima al file. */
export function taskTabContextId(taskId: string, topicId: string, name?: string): string {
  const slug = slugTabName(name);
  return slug
    ? `task-${taskId.slice(0, 8)}-n${slug}`
    : `task-${taskId.slice(0, 8)}-a${topicId.slice(0, 8)}`;
}

/** L'id della pane che ospita questa tab nel workspace del progetto. */
export function workspaceTwinContextId(tabContextId: string): string {
  return tabContextId.endsWith(WORKSPACE_TWIN_SUFFIX) ? tabContextId : `${tabContextId}${WORKSPACE_TWIN_SUFFIX}`;
}

/** La tab dietro un contextId, che sia la tab stessa o il suo gemello. */
export function taskTabContextIdOf(contextId: string): string {
  return contextId.endsWith(WORKSPACE_TWIN_SUFFIX)
    ? contextId.slice(0, -WORKSPACE_TWIN_SUFFIX.length)
    : contextId;
}

/** True per un contextId posseduto da un task (la tab o il suo gemello). */
export function isTaskContextId(contextId: string): boolean {
  return typeof contextId === "string" && contextId.startsWith("task-");
}
