/**
 * IL PONTE MCP DEL BROWSER — le sei rotte con cui una CLI (claude-code, codex)
 * guida il pannello browser, estratte dal file-dio `topics.ts`.
 *
 * Sono la controparte REST dei tool `browser_*` che i provider SDK ricevono
 * inline come `Tool[]`: una CLI non può riceverli, quindi il server MCP
 * (`server/mcp/topics-mcp-server.ts`) li chiama qui. Ogni rotta esiste in DUE
 * forme d'indirizzo — `/api/topics/:id/browser/…` per chi conosce già la topic,
 * `/api/sessions/:sessionKey/browser/…` per il sottoprocesso MCP, che al momento
 * dello spawn conosce solo la sessionKey — e le due forme finiscono nello stesso
 * handler.
 *
 * COSA TIENE INSIEME QUESTO MODULO, e perché è lui il confine giusto: la
 * RISOLUZIONE DEL CONTESTO. Un `contextId` di browser può nascere da tre posti
 * diversi, e i tre helper che lo decidono (`resolveBrowserContext`,
 * `resolveTaskBrowserContext`, `buildTabDeps`) vivevano nella closure di
 * `createTopicsRouter` senza che NESSUN'altra rotta li usasse:
 *   · chat topic  → `resolveContextIdForTopic(topic)` (di norma `topic.id`)
 *   · task        → `task-<id8>-a<topic8>`, stabile per (task, topic) così che
 *                   riaprire riusi la STESSA scheda dentro il drawer
 *   · terminale   → `term-<id>`, l'id deterministico sotto cui il client
 *                   registra il pannello accanto al terminale
 * Chiuse lì dentro non erano provabili; qui sono dipendenze scritte e la scelta
 * fra i tre rami ha finalmente dei test (`browser-bridge.test.ts`).
 *
 * NON è ctx-puro (a differenza dello scorporo del canale umano): `browserService`
 * arriva come terzo argomento — assente nelle build senza browser, e ogni rotta
 * che ne ha bisogno risponde 503 — mentre `getTerminalSessionById`, le due
 * letture sui task e `browserNavigatedTopics` sono iniettati (vedi
 * {@link BrowserBridgeDeps}). `browserNavigatedTopics` è stato mutabile
 * CONDIVISO: dev'essere la stessa istanza che usano `chat.ts` e il ripiego
 * localhost in `topics.ts`, altrimenti la deduplica si sdoppia.
 *
 * ORDINE DI ROTTA. `matchRoute` confronta il numero di segmenti prima di
 * confrontarli uno a uno, e in `topics.ts` le uniche rotte a sei segmenti sono
 * queste più `/api/topics/:id/link/:targetId` (che ha un letterale diverso al
 * terzo posto). Montare il sotto-router dove stava `open-pane` — cioè PRIMA di
 * `move-to-project`, `ask-user`, `permission`, `switch-topic` e compagnia, tutte
 * a cinque segmenti — non cambia nessuna precedenza.
 *
 * Il comportamento è una mossa verbatim: cambia solo l'involucro di dispatch.
 */
import type { AppContext, RouteHandler, Topic } from "../types";
import type { BrowserService } from "../browser-service";
import { dispatchBrowserToolCallByContext, resolveContextIdForTopic } from "../browser-tool-dispatcher";
import { BRIDGED_BROWSER_ENDPOINTS } from "../browser-tool-spec";
import { resolveAgentNavUrl } from "../browser-tools-handler";
import { nativeDelegateRegistry } from "../browser-native-delegate";
import { collectLiveContextIds, listBrowserTabs, type TabInventoryDeps } from "../browser-tab-inventory";
import { timingSafeEqualStr } from "../utils";
import { taskTabContextId, slugTabName } from "../../shared/task-tab-context";
import { checkPortOwnership, formatPortWarning, realPortOwnerDeps, type PortOwnerDeps } from "../lib/port-project-owner";

/**
 * Le sessioni di terminale viste da qui: solo i tre campi che servono a dare un
 * nome e un contesto al pannello accanto al terminale. Tipo strutturale apposta,
 * così il modulo non importa `routes/terminal` e i test possono passare una
 * mappa finta.
 */
export interface TerminalSessionRef {
  id: string;
  name: string;
  cwd: string;
}

/**
 * Ciò che il ponte non può dedurre da `AppContext`, iniettato per riferimento
 * (stesso patto di `ChatDeps` in chat.ts).
 *
 * `browserNavigatedTopics` è SHARED MUTABLE STATE: passa la stessa istanza che
 * usano il marker localhost e `createChatRouter`, altrimenti «questa topic ha
 * già navigato» diventa vero in un posto e falso nell'altro.
 *
 * `taskForTopic` / `taskByIdPrefix` sono le due sole letture sui task che
 * servono: la prima decide se una topic è un dispatch di board (→ fork del
 * browser dentro il drawer del task), la seconda ritrova il task da un
 * `contextId` `task-<id8>-…` per etichettare la scheda nell'inventario.
 *
 * `persistTaskTab` è la SCRITTURA del record `task-browser-tabs:<taskId>`
 * (`services/task-tab-persist`): arriva iniettata invece che importata perché è
 * l'unica cosa qui dentro che tocca il database, e chiuderla dentro il modulo
 * avrebbe costretto ogni test del ramo task ad avere uno sqlite vero.
 * `attachLoginHandle` è la sua gemella per il login già iniettato, e sta qui per
 * la stessa ragione.
 */
export interface BrowserBridgeDeps {
  getTerminalSessionById: (id: string) => TerminalSessionRef | undefined;
  taskForTopic: (topicId: string) => { id: string } | null | undefined;
  taskByIdPrefix: (prefix: string) => { text: string } | null | undefined;
  browserNavigatedTopics: Set<string>;
  persistTaskTab: (taskId: string, contextId: string, url: string, title?: string) => void;
  /** Lega un handle di `browser_save_state` alla tab del task che lo ha prodotto. */
  attachLoginHandle: (contextId: string, handle: string) => void;
  /**
   * «C'è una pane VIVA agganciata a questo contextId?» — cioè un client che ha
   * aperto `/ws/browser/<contextId>`: una pane nativa (delegato) o una web che
   * guarda lo screencast. È l'UNICO segnale che il server ha del fatto che
   * qualcuno stia davvero VEDENDO il browser che ha appena aperto: il contesto
   * headless esiste comunque, quindi senza questo `open-pane` non può
   * distinguere «montato» da «invisibile» e risponde uguale nei due casi.
   * Iniettata perché il registro (`browserWsClients`) vive in `server.ts`.
   */
  paneAttachedTo: (contextId: string) => boolean;
  /**
   * Quanto si aspetta che una pane si agganci, per finestra (due finestre: una
   * dopo il broadcast normale, una dopo il ripiego `browser:force-open`).
   * Default 2500 ms — sopra il tempo di mount+socket su una macchina locale.
   * I test la stringono a pochi ms.
   */
  paneWaitMs?: number;
  /**
   * Injectable seam for the localhost-port ownership check (task f9cf765e):
   * defaults to the real `lsof`-backed deps, tests substitute fakes so the
   * warning path never touches the machine's actual listening ports.
   */
  portOwnerDeps?: PortOwnerDeps;
}

export function createBrowserBridgeRouter(
  ctx: AppContext,
  deps: BrowserBridgeDeps,
  browserService?: BrowserService,
): RouteHandler {
  const {
    broadcastToAll, loadTopics, saveSingleTopic,
    getTopicById, getTopicBySessionKey,
    readJSON, json, matchRoute,
  } = ctx;
  const { getTerminalSessionById, taskForTopic, taskByIdPrefix, browserNavigatedTopics, persistTaskTab, attachLoginHandle, paneAttachedTo } = deps;
  const PANE_WAIT_MS = deps.paneWaitMs ?? 2500;
  const PANE_POLL_MS = 50;
  const portOwnerDeps = deps.portOwnerDeps ?? realPortOwnerDeps();

  /**
   * The localhost-port warning (task f9cf765e): does this URL point at a port
   * whose owner is a DIFFERENT project than `callerProjectPath`, or at a port
   * nobody answers on? Never blocks, never throws into open-pane — a probe
   * that fails to answer its own question is just silent.
   */
  async function portOwnershipWarning(url: string, callerProjectPath: string | null): Promise<string | undefined> {
    try {
      const warning = await checkPortOwnership(url, callerProjectPath, portOwnerDeps);
      return warning ? formatPortWarning(warning) : undefined;
    } catch {
      return undefined;
    }
  }

  // Server gate for the task-owned browser fork (client mirror:
  // localStorage['board:taskBrowser']). Default ON → an agent open-pane on a
  // task topic routes to the task's browser group; set TOPICS_TASK_BROWSER='0'
  // as a kill-switch to fall back to the layout-level `browser:navigate`.
  // Letto una volta sola, alla costruzione del router, esattamente come prima.
  const TASK_BROWSER_ENABLED = process.env.TOPICS_TASK_BROWSER !== "0";

  /**
   * If `topic` is a task dispatch AND the fork is enabled, the canonical
   * task-scoped browser handle. The contextId is STABLE per (task, topic, name)
   * so repeated opens reuse the SAME in-drawer tab (idempotent client upsert),
   * and self-describing (`task-<id8>-…`) so labelForContext + the store
   * recognise it without a lookup. Null → the caller falls back to the normal
   * chat pane.
   *
   * `name` è il manifesto: senza nome c'è UNA tab per agente (che ri-naviga a
   * ogni apertura), con un nome c'è una tab PER NOME — è così che un task
   * consegna più superfici invece di sovrascrivere sempre la stessa.
   */
  function resolveTaskBrowserContext(topic: Topic, name?: string): { taskId: string; contextId: string } | null {
    if (!TASK_BROWSER_ENABLED) return null;
    const task = taskForTopic(topic.id);
    if (!task) return null;
    return { taskId: task.id, contextId: taskTabContextId(task.id, topic.id, name) };
  }

  /**
   * Resolve the browser-pane contextId for an MCP bridge call addressed by
   * topic id OR session key. Handles BOTH Claude Code surfaces:
   *   - chat topic   → contextId = the topic's own browser contextId (topic.id)
   *   - terminal tab → contextId = `term-<terminalId>` (the deterministic id the
   *     client registers the near-terminal pane under, see open-pane below)
   * Returns null when neither matches (genuinely unbound session). `topic` is
   * returned when present so callers that still need it (broadcasts) have it.
   */
  function resolveBrowserContext(
    byTopic: Record<string, string> | null,
    bySession: Record<string, string> | null,
  ): { contextId: string; topic: Topic | null } | null {
    if (byTopic) {
      const topic = getTopicById(byTopic.id);
      if (!topic) return null;
      return { contextId: resolveContextIdForTopic(topic), topic };
    }
    if (bySession) {
      const key = decodeURIComponent(bySession.sessionKey);
      const topic = getTopicBySessionKey(key);
      if (topic) return { contextId: resolveContextIdForTopic(topic), topic };
      const term = getTerminalSessionById(key);
      if (term) return { contextId: `term-${term.id}`, topic: null };
    }
    return null;
  }

  /** Aspetta che una pane si agganci al contextId, o si arrende alla scadenza. */
  async function waitForAttachedPane(contextId: string, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      if (paneAttachedTo(contextId)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, Math.min(PANE_POLL_MS, Math.max(1, deadline - Date.now()))));
    }
  }

  /**
   * IL RIPIEGO CHE NON ESISTEVA. `browser:force-open` aveva tipo, schema Zod e
   * handler nel client (`usePanelLifecycle`) — documentato come «quando il
   * broadcast normale non ha montato NESSUNA pane visibile» — ma NESSUNO lo
   * emetteva (`tests/unit/ws-outbound-coverage.test.ts` lo annotava:
   * «emissione server assente»). Risultato osservato l'11/08/2026: contesto
   * vivo, pane mai montata, l'utente non vede niente e il tool risponde
   * «Opened browser pane at …» lo stesso.
   *
   * Qui il ripiego viene finalmente armato: dopo il broadcast normale si
   * aspetta che una pane si agganci al contextId; se nessuna lo fa si chiede
   * alla finestra primaria di aprirne una a forza, e si aspetta ancora. Il
   * booleano che torna è ciò che rende ONESTA la risposta della rotta.
   *
   * Perché due attese e non un ack esplicito: l'aggancio del socket
   * `/ws/browser/<ctx>` è già il segnale che la pane esiste ED è viva (lo apre
   * sia la pane nativa che quella web), quindi non serve un protocollo nuovo
   * che poi vivrebbe non provato accanto a questo.
   */
  async function forceOpenAndWait(contextId: string, url: string): Promise<boolean> {
    broadcastToAll({ type: "browser:force-open", contextId, url });
    return waitForAttachedPane(contextId, PANE_WAIT_MS);
  }

  /**
   * THE OPENING SEQUENCE, WRITTEN ONCE, FOR ALL THREE BRANCHES.
   *
   * `open-pane` has three origins (chat, board task, terminal) and each one had
   * written its own sequence. The task branch had dropped two steps along the
   * way: it waited for no pane and it never navigated, so it answered "Opened"
   * while the tab sat on `about:blank` and the agent had to force the load by
   * hand with `location.replace` (card 05105d29). Patching the third branch
   * would only have been waiting for the fourth branch to be born with the same
   * hole, so the sequence lives here and the three branches CALL it:
   *
   *   1. ANNOUNCE   the broadcast that mounts/updates the pane. It is the only
   *                 thing that differs between branches (layout pane, drawer
   *                 tab, near-terminal pane);
   *   2. WAIT       for someone to attach to the contextId, BEFORE navigating:
   *                 this is the window in which a native pane can register as
   *                 the delegate, and therefore take the navigation itself
   *                 instead of leaving it to a headless phantom;
   *   3. NAVIGATE   a `browser_open` on the context. It reaches the native pane
   *                 if one registered, otherwise the headless context, which is
   *                 where observe/act will land anyway. This is the step that
   *                 was missing, and it is also what re-navigates an ALREADY
   *                 mounted tab (the client reads `initialUrl` only at mount);
   *   4. RE-ANNOUNCE  if the navigation redirected, so the pane follows the
   *                 final URL instead of staying on the starting one;
   *   5. FALLBACK   if nobody attached, `browser:force-open` with the FINAL URL
   *                 (a forced pane loads its initialUrl and nothing else:
   *                 handing it the starting URL would leave it on the wrong
   *                 page), then wait again.
   *
   * The `visible` boolean that comes out is what makes the answer HONEST: a
   * tool that says "Opened" when it opened nothing is not a navigation defect,
   * it is a tool lying to a caller who has no way to check.
   *
   * The differences between branches stay, but DECLARED as parameters instead
   * of forgotten: `forceOpen` (the task branch turns it off, because a forced
   * standalone pane would take the tab OUTSIDE the drawer, away from where the
   * reviewer looks for it) and `title` (the name prescribed for the tab, or the
   * page title when there is none).
   */
  async function openPaneFlow(opts: {
    contextId: string;
    url: string;
    /** Title to report to the agent; absent = the navigated page's own title. */
    title?: string;
    projectPath: string | null;
    service: BrowserService;
    /** The branch's broadcast. Called again with the final URL on a redirect. */
    announce: (url: string) => void;
    /** `browser:force-open` fallback when no pane attaches (defaults to yes). */
    forceOpen?: boolean;
    /**
     * Does a failed navigation kill the whole call? Yes by default: a chat pane
     * that could not load has produced nothing, and an error is the truth. The
     * task branch says no, because there the tab RECORD is the deliverable and
     * it was already written and announced: answering 500 would tell the agent
     * the tab does not exist while it sits in the drawer. It gets a 200 with
     * the failure in `warning` instead, which is the same information without
     * the lie.
     */
    navigationFatal?: boolean;
  }): Promise<Response> {
    const { contextId, url, projectPath, service, announce } = opts;
    announce(url);
    const attached = await waitForAttachedPane(contextId, PANE_WAIT_MS);
    let resolvedUrl = url;
    let pageTitle = "";
    let navError = "";
    try {
      const result = (await dispatchBrowserToolCallByContext(
        "browser_open",
        { url },
        contextId,
        service,
      )) as { url?: string; title?: string; error?: string };
      if (result?.error) {
        if (opts.navigationFatal !== false) return json({ error: result.error }, 502);
        navError = result.error;
      }
      if (typeof result?.url === "string" && result.url) resolvedUrl = result.url;
      pageTitle = typeof result?.title === "string" ? result.title : "";
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (opts.navigationFatal !== false) return json({ error: msg }, 500);
      navError = msg;
    }
    if (resolvedUrl !== url) announce(resolvedUrl);
    const visible = navError
      ? false
      : attached
        ? true
        : opts.forceOpen === false
          ? false
          : await forceOpenAndWait(contextId, resolvedUrl);
    const portWarning = await portOwnershipWarning(resolvedUrl, projectPath);
    const warning = [navError ? `navigation failed: ${navError}` : "", portWarning ?? ""]
      .filter(Boolean)
      .join(" ");
    return json({
      url: resolvedUrl,
      title: opts.title ?? pageTitle,
      visible,
      ...(warning ? { warning } : {}),
    });
  }

  /**
   * Build the injected deps for the tab inventory (browser-tab-inventory.ts)
   * from the live singletons. `fetchNativeStatus` calls the native registry
   * DIRECTLY (not through dispatchBrowserToolCallByContext) so listing tabs
   * doesn't flash the agent-active pill on every open pane. Requires a live
   * browserService for CDP contexts (callers 503 when it's absent).
   */
  function buildTabDeps(svc: BrowserService): TabInventoryDeps {
    return {
      listDelegated: () => nativeDelegateRegistry.listDelegated(),
      listContexts: () => (svc.listContexts?.() ?? []).map((c) => ({ id: c.id, url: c.url, title: c.title })),
      getTopicById,
      findTopicByContextId: (contextId) => {
        for (const t of Object.values(loadTopics().topics)) {
          if (t.browserState?.contextId === contextId) return t;
        }
        return null;
      },
      getTerminalSessionById: (id) => {
        const t = getTerminalSessionById(id);
        return t ? { id: t.id, name: t.name, cwd: t.cwd } : undefined;
      },
      getTaskByContextId: (contextId) => {
        // `task-<id8>-…` → owning task (label "Task: <text>"). id8 is the task
        // id's 8-char hex prefix; resolve it back to the row.
        const m = /^task-([0-9a-f]{1,32})-/i.exec(contextId);
        if (!m) return null;
        const task = taskByIdPrefix(m[1]);
        return task ? { text: task.text } : null;
      },
      fetchNativeStatus: async (contextId) => {
        if (!nativeDelegateRegistry.isDelegated(contextId)) return null;
        const res = await nativeDelegateRegistry.delegateOp(contextId, "browser_status", {});
        if (res && typeof res === "object" && !("error" in res)) {
          return res as { url?: string; title?: string };
        }
        return null;
      },
    };
  }

  /**
   * Il cancello delle rotte sensibili: il server ascolta su 0.0.0.0, quindi
   * import-chrome, i tool generici, list-tabs e focus-pane vogliono il token del
   * gateway (il bridge MCP lo manda sempre; il percorso SDK non passa di qui,
   * dispatcia in-process). `open-pane` e `close-pane` restano scoperte com'erano
   * — aprire o chiudere un pannello non legge cookie né espone gli URL altrui.
   */
  const tokenOk = (req: Request): boolean => {
    const tok = req.headers.get("x-gateway-token") || "";
    return !!process.env.GATEWAY_TOKEN && timingSafeEqualStr(tok, process.env.GATEWAY_TOKEN);
  };

  return async function browserBridgeRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    // POST /api/topics/:id/browser/open-pane
    // POST /api/sessions/:sessionKey/browser/open-pane
    //
    // The MCP bridge surface for non-SDK providers (claude-code CLI, codex CLI):
    // these providers can't receive an inline `browser_open` Anthropic Tool[]
    // through topics-app, so they invoke this endpoint via the MCP server
    // spawned at server/mcp/topics-mcp-server.ts (wired in claude-code provider
    // through `--mcp-config`). End result is identical to the SDK tool path:
    //   1. Playwright navigates the topic's headless context
    //   2. browser:navigate WS broadcast opens/focuses the user-facing pane
    //   3. browserNavigatedTopics is seeded to suppress the localhost-URL fallback
    //
    // Two address forms because:
    //   - topic-id: easy for REST callers that already know the topic
    //   - session-key: the claude-code MCP subprocess only has the sessionKey
    //     it was spawned under (the topicId would require an extra DB round-trip
    //     at spawn time). Both forms resolve to the same handler.
    {
      const byTopic = matchRoute(pathname, "/api/topics/:id/browser/open-pane");
      const bySession = matchRoute(pathname, "/api/sessions/:sessionKey/browser/open-pane");
      if ((byTopic || bySession) && method === "POST") {
        if (!browserService) {
          return json({ error: "Browser service is not enabled in this build" }, 503);
        }
        let topic: Topic | null = null;
        if (byTopic) {
          topic = getTopicById(byTopic.id);
        } else if (bySession) {
          topic = getTopicBySessionKey(decodeURIComponent(bySession.sessionKey));
        }

        // Terminal-originated open: the MCP bridge for a Claude Code *terminal*
        // passes the terminal session id as the sessionKey, which matches no
        // chat topic. Instead of 404, open the browser in the same layout group
        // as the terminal pane. The client resolves the group from the pane id
        // — works for both standalone (group:default) and project layouts — and
        // uses that group's own browser context, then navigates. We don't
        // pre-open a server browser context here (the contextId differs between
        // standalone and project rendering); the client's RemoteBrowserPanel
        // drives the actual open/navigate once the pane mounts.
        if (!topic && bySession) {
          const term = getTerminalSessionById(decodeURIComponent(bySession.sessionKey));
          if (term) {
            const body = (await readJSON(req)) as { url?: unknown } | null;
            const url = typeof body?.url === "string" ? body.url : "";
            if (!url) return json({ error: "url (string) is required" }, 400);
            // contextId is deterministic (`term-<id>`) so the client registers
            // the pane's CDP target under the SAME id the observe/act routes
            // resolve to — that's what lets a terminal drive the pane, not just
            // open it.
            const ctxId = `term-${term.id}`;
            // The broadcast opens the near-terminal pane under ctxId and seeds
            // it with `url` (initialUrl); the rest of the sequence (wait,
            // navigate, redirect) is the shared one. The terminal may be a tab
            // nowhere at all (headless dispatch, window closed): same blindness
            // as the chat route, same fallback, same honest answer. The title
            // stays empty: here the agent asked for a pane next to its
            // terminal, not for a page to label.
            return openPaneFlow({
              contextId: ctxId,
              url,
              title: "",
              projectPath: term.cwd || null,
              service: browserService,
              announce: (u) => broadcastToAll({ type: "browser:open-near-pane", paneId: `terminal:${term.id}`, contextId: ctxId, url: u }),
            });
          }
        }
        if (!topic) return json({ error: "Topic not found" }, 404);

        const body = (await readJSON(req)) as { url?: unknown; name?: unknown } | null;
        const requestedUrl = typeof body?.url === "string" ? body.url : "";
        if (!requestedUrl) return json({ error: "url (string) is required" }, 400);
        // Un file locale diventa il RIFERIMENTO che lo serve, PRIMA di essere
        // annunciato alla finestra. Il broadcast qui sotto parte prima del
        // dispatch, quindi con l'URL grezzo la pane riceveva `file://` — cioè
        // esattamente il bianco — e lo correggeva solo dopo, se il dispatch
        // andava a buon fine. Riscritto qui, alla pane arriva subito l'unico
        // indirizzo che sa aprire. Relativo: l'origine ce l'ha lei.
        let url: string;
        try {
          url = resolveAgentNavUrl(requestedUrl, "open_browser_pane", "relative");
        } catch (err) {
          // 400 col motivo, non un 500 muto: è il messaggio che l'agente legge
          // e che decide se riprova o si ferma.
          return json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
        // Il NOME della tab, quando l'agente lo prescrive. Fuori da un task non
        // significa niente (il pane-store globale etichetta dal titolo pagina):
        // lì viene semplicemente ignorato. Un nome fatto di soli simboli non
        // conia niente — `slugTabName` lo riduce a "" e si ricade sulla tab
        // senza nome, invece di collezionarli tutti in un id degenere.
        const rawName = typeof body?.name === "string" ? body.name.trim() : "";
        const tabName = slugTabName(rawName) ? rawName : "";

        // Task-owned browser fork (feature-flagged): the agent working a task
        // opens a browser into that task's IN-DRAWER group, not the global
        // layout. Same sequence as the other two branches (`openPaneFlow`),
        // with two declared differences: the tab record is WRITTEN before it is
        // announced, and visibility is settled WITHOUT the `browser:force-open`
        // fallback, which would open a standalone pane outside the drawer, away
        // from where the reviewer looks for it. `visible:false` here means
        // "drawer closed": the navigation still went to the headless context,
        // which is exactly where observe/act will land.
        const taskCtx = resolveTaskBrowserContext(topic, tabName);
        if (taskCtx) {
          topic.browserState = {
            url,
            contextId: taskCtx.contextId,
            lastActiveAt: Date.now(),
            viewport: topic.browserState?.viewport,
          };
          saveSingleTopic(topic);
          browserNavigatedTopics.add(topic.id);
          return openPaneFlow({
            contextId: taskCtx.contextId,
            url,
            title: tabName,
            projectPath: topic.projectPath ?? null,
            service: browserService,
            // Persist BEFORE broadcasting: the tab is the task's result and a
            // dispatch often runs with no Topics window open at all. As long as
            // the only writer of the record was the client, "no client
            // connected" meant a lost tab. Now the record is there regardless;
            // the client receiving `browser:open-task-tab` does the same
            // idempotent upsert and converges. This holds for a redirect's
            // landing URL too: the tab follows that one, not the starting one.
            announce: (u) => {
              persistTaskTab(taskCtx.taskId, taskCtx.contextId, u, tabName);
              broadcastToAll({ type: "browser:open-task-tab", taskId: taskCtx.taskId, contextId: taskCtx.contextId, url: u, title: tabName });
            },
            forceOpen: false,
            navigationFatal: false,
          });
        }

        const ctxId = resolveContextIdForTopic(topic);
        browserNavigatedTopics.add(topic.id);
        // The announcement comes BEFORE the navigation (the shared sequence
        // guarantees it) so the client mounts/seeds the pane under the SAME id
        // the agent's `browser_*` tools resolve to. Inverted, Playwright drove
        // a phantom while the visible pane stayed on about:blank.
        return openPaneFlow({
          contextId: ctxId,
          url,
          projectPath: topic.projectPath ?? null,
          service: browserService,
          announce: (u) => broadcastToAll({ type: "browser:navigate", topicId: topic.id, contextId: ctxId, url: u }),
        });
      }
    }

    // POST /api/topics/:id/browser/close-pane
    // POST /api/sessions/:sessionKey/browser/close-pane
    //
    // Symmetric counterpart of open-pane (close_browser_pane MCP tool): asks
    // every live window that renders `browser:<ctx>` to close it through its
    // NORMAL close flow (X-button semantics). This must be client-originated:
    // the membership keys are LWW documents that live clients re-persist from
    // memory, so a server-side state edit gets clobbered back within seconds.
    // Resolution mirrors open-pane (topic → topic.id, terminal → term-<id>);
    // an explicit body.contextId wins (close a specific pane you spawned).
    // Best-effort: the server-side headless context is destroyed too, so web
    // clients don't keep streaming a pane that no window shows anymore.
    {
      const byTopic = matchRoute(pathname, "/api/topics/:id/browser/close-pane");
      const bySession = matchRoute(pathname, "/api/sessions/:sessionKey/browser/close-pane");
      if ((byTopic || bySession) && method === "POST") {
        const body = (await readJSON(req)) as { contextId?: unknown } | null;
        let ctxId = typeof body?.contextId === "string" && body.contextId ? body.contextId : "";
        if (!ctxId) {
          let topic: Topic | null = null;
          if (byTopic) topic = getTopicById(byTopic.id);
          else if (bySession) topic = getTopicBySessionKey(decodeURIComponent(bySession.sessionKey));
          if (topic) {
            ctxId = resolveContextIdForTopic(topic);
          } else if (bySession) {
            const term = getTerminalSessionById(decodeURIComponent(bySession.sessionKey));
            if (term) ctxId = `term-${term.id}`;
          }
        }
        if (!ctxId) return json({ error: "No browser context resolvable for this session (pass contextId)" }, 404);
        broadcastToAll({ type: "browser:close-pane", contextId: ctxId });
        if (browserService) {
          try { await browserService.destroyContext(ctxId); } catch { /* no headless context — native-only pane */ }
        }
        return json({ ok: true, contextId: ctxId });
      }
    }

    // POST /api/topics/:id/browser/import-chrome
    // POST /api/sessions/:sessionKey/browser/import-chrome
    //
    // MCP bridge for the `import_chrome` tool (claude-code CLI sessions): seed the
    // topic's native browser pane with the user's real Chrome cookies. Same handler
    // as the SDK chat tool path (dispatchBrowserToolCall -> handleBrowserImportChrome),
    // which requires the Electron native pane (CDP). Resolves the pane by topic
    // OR terminal session (resolveBrowserContext), so a Claude Code terminal tab
    // can seed its own near-terminal pane too.
    {
      const byTopic = matchRoute(pathname, "/api/topics/:id/browser/import-chrome");
      const bySession = matchRoute(pathname, "/api/sessions/:sessionKey/browser/import-chrome");
      if ((byTopic || bySession) && method === "POST") {
        // import-chrome decrypts the user's REAL Chrome session cookies — far more
        // sensitive than open-pane's navigate. The server binds 0.0.0.0, so require
        // the gateway token (the MCP bridge always sends X-Gateway-Token; the SDK
        // chat path never hits this route — it dispatches in-process). Stops a LAN
        // peer / local process from triggering a confused-deputy cookie import.
        if (!tokenOk(req)) {
          return json({ error: "unauthorized" }, 401);
        }
        if (!browserService) {
          return json({ error: "Browser service is not enabled in this build" }, 503);
        }
        const target = resolveBrowserContext(byTopic, bySession);
        if (!target) return json({ error: "No browser pane bound to this session (open a browser pane first)" }, 404);

        const body = (await readJSON(req)) as { domains?: unknown; profile?: unknown; dry_run?: unknown; browser?: unknown } | null;
        const domains = Array.isArray(body?.domains) ? body.domains.map(String) : [];
        const profile = typeof body?.profile === "string" ? body.profile : undefined;
        const dryRun = !!body?.dry_run;
        // Which Chromium-family browser to read from (chrome default). Validated
        // downstream against a closed registry — an unknown id degrades to chrome.
        const browser = typeof body?.browser === "string" ? body.browser : undefined;
        try {
          const result = await dispatchBrowserToolCallByContext(
            "browser_import_chrome",
            { domains, profile, dry_run: dryRun, browser },
            target.contextId,
            browserService,
          ) as { error?: string };
          if (result?.error) return json({ error: result.error }, 502);
          return json(result as Record<string, unknown>);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return json({ error: msg }, 500);
        }
      }
    }

    // POST /api/{topics/:id,sessions/:sessionKey}/browser/:tool
    // Generic MCP bridge for the ref-based browser tools (observe/act/extract/
    // get_text/screenshot/eval and, later, read_screen/save_state/load_state).
    // ONE block, projected from the single source of truth (browser-tool-spec.ts)
    // so the REST surface can't drift from the MCP/passthrough surfaces. Same
    // handler as the SDK chat path; token-gated like import-chrome. Resolves the
    // pane by topic OR terminal session so a Claude Code terminal tab can drive
    // its own near-terminal pane. open-pane/import-chrome keep bespoke blocks
    // above (not in BRIDGED_BROWSER_ENDPOINTS), so this never shadows them.
    {
      const byTopic = matchRoute(pathname, "/api/topics/:id/browser/:tool");
      const bySession = matchRoute(pathname, "/api/sessions/:sessionKey/browser/:tool");
      const m = byTopic || bySession;
      const endpoint = m?.tool;
      const toolName = endpoint ? BRIDGED_BROWSER_ENDPOINTS[endpoint] : undefined;
      if (m && method === "POST" && toolName) {
        if (!tokenOk(req)) return json({ error: "unauthorized" }, 401);
        if (!browserService) return json({ error: "Browser service is not enabled in this build" }, 503);
        // Read the body FIRST so an explicit `contextId` override can retarget any
        // live tab (the "manage any tab" capability) — and so a pane-less session
        // can still drive another tab. `contextId` is stripped before dispatch so
        // it never leaks into a tool handler's args.
        const body = ((await readJSON(req)) as Record<string, unknown> | null) ?? {};
        const override = typeof body.contextId === "string" && body.contextId ? body.contextId : null;
        delete body.contextId;
        let contextId: string;
        if (override) {
          // Validate against the live inventory: an unknown contextId would
          // otherwise make getOrCreateContext upsert a phantom headless context.
          const live = collectLiveContextIds(buildTabDeps(browserService));
          if (!live.has(override)) {
            return json({
              error: `unknown contextId '${override}'. Live tabs: ${[...live].join(", ") || "(none)"}. Call browser_list_tabs for the current list.`,
            }, 404);
          }
          contextId = override;
        } else {
          const target = resolveBrowserContext(byTopic, bySession);
          if (!target) return json({ error: "No browser pane bound to this session (open a browser pane first, or pass contextId from browser_list_tabs)" }, 404);
          contextId = target.contextId;
        }
        try {
          const result = await dispatchBrowserToolCallByContext(
            toolName,
            body,
            contextId,
            browserService,
          ) as Record<string, unknown> & { error?: string };
          if (result?.error) return json({ error: result.error }, 502);
          // Login già iniettato: un `browser_save_state` fatto SU una tab di un
          // task lega quell'handle a QUELLA tab. Chi la apre dopo — drawer del
          // task o workspace del progetto — se lo fa dare da
          // `/api/browsers/:id/login-handle` e lo inietta, così il reviewer
          // atterra dentro invece che sul muro del login. Best-effort e dopo il
          // salvataggio riuscito: se il contextId non è di nessun task, no-op.
          //
          // L'handle registrato è quello che il tool ha REALMENTE scritto
          // (`result.handle`, già passato da `safeHandle`), non la stringa
          // grezza dell'agente: è il nome del file su disco, ed è quello che
          // `/login-state/apply` dovrà ridare a `browser_load_state`.
          if (toolName === "browser_save_state") {
            const savedHandle = typeof result?.handle === "string" && result.handle
              ? result.handle
              : (typeof body.handle === "string" ? body.handle : "");
            if (savedHandle) attachLoginHandle(contextId, savedHandle);
          }
          return json(result);
        } catch (e: unknown) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
      }
    }

    // POST /api/{topics/:id,sessions/:sessionKey}/browser/list-tabs
    // Inventory of EVERY live browser tab (all topics/terminals/windows), not
    // just this session's own — the discovery half of "manage any tab". Bespoke
    // (not in BRIDGED_BROWSER_ENDPOINTS): it's inventory-scoped and needs `isOwn`
    // computed from the caller's own contextId, so it doesn't fit the per-context
    // dispatcher. Token-gated like the bridge (it exposes urls/titles of every
    // pane). A pane-less caller still lists (no 404 on a null own-context).
    {
      const byTopic = matchRoute(pathname, "/api/topics/:id/browser/list-tabs");
      const bySession = matchRoute(pathname, "/api/sessions/:sessionKey/browser/list-tabs");
      if ((byTopic || bySession) && method === "POST") {
        if (!tokenOk(req)) return json({ error: "unauthorized" }, 401);
        if (!browserService) return json({ error: "Browser service is not enabled in this build" }, 503);
        const own = resolveBrowserContext(byTopic, bySession)?.contextId ?? null;
        try {
          const tabs = await listBrowserTabs(buildTabDeps(browserService), own);
          return json({ tabs });
        } catch (e: unknown) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
      }
    }

    // POST /api/{topics/:id,sessions/:sessionKey}/browser/focus-pane
    // Bring a browser tab to the front in whichever window shows it — the
    // management half of "manage any tab". Mirrors close-pane's broadcast path
    // (browser:focus-pane → usePanelLifecycle → useProjectLayout activation);
    // client-originated because tab-activation is device-local UI state. An
    // explicit body.contextId wins (VALIDATED against the live inventory —
    // focusing a dead pane is meaningless); else own via topic/term-<id>.
    {
      const byTopic = matchRoute(pathname, "/api/topics/:id/browser/focus-pane");
      const bySession = matchRoute(pathname, "/api/sessions/:sessionKey/browser/focus-pane");
      if ((byTopic || bySession) && method === "POST") {
        if (!tokenOk(req)) return json({ error: "unauthorized" }, 401);
        if (!browserService) return json({ error: "Browser service is not enabled in this build" }, 503);
        const body = (await readJSON(req)) as { contextId?: unknown } | null;
        const override = typeof body?.contextId === "string" && body.contextId ? body.contextId : null;
        let ctxId: string;
        if (override) {
          const live = collectLiveContextIds(buildTabDeps(browserService));
          if (!live.has(override)) {
            return json({
              error: `unknown contextId '${override}'. Live tabs: ${[...live].join(", ") || "(none)"}. Call browser_list_tabs for the current list.`,
            }, 404);
          }
          ctxId = override;
        } else {
          const target = resolveBrowserContext(byTopic, bySession);
          if (!target) return json({ error: "No browser pane bound to this session (pass contextId from browser_list_tabs)" }, 404);
          ctxId = target.contextId;
        }
        broadcastToAll({ type: "browser:focus-pane", contextId: ctxId });
        return json({ ok: true, contextId: ctxId });
      }
    }

    return null;
  };
}
