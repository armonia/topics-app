import type { Database } from "bun:sqlite";
import type { OutboundMessage } from "../../shared/ws-outbound";
import { projectPanesKey } from "../../shared/project-keys";

const APP_KEY = "pane-store-v2";

/** Cosa spostare dentro un progetto, in un colpo solo. */
export interface RelocationRequest {
  /**
   * Pane NON-chat da spostare (terminale, browser). Ogni voce viene tolta dallo
   * store standalone e aggiunta a `nonChatPanes` con la stessa forma che aveva;
   * `fallback` serve solo quando la pane non è (ancora) nello store standalone
   * e va comunque dichiarata al progetto.
   */
  panes?: Array<{ id: string; fallback?: Record<string, unknown> }>;
  /**
   * Topic di chat da rendere aperti DENTRO il progetto: l'id finisce in
   * `openChatTopicIds` e la sua pane standalone (id nudo o `chat:<id>`) viene
   * tolta di mezzo, perché la stessa chat non può stare su due superfici.
   */
  chatTopicIds?: string[];
}

/**
 * Sposta pane e chat dentro la finestra di progetto, server-side e
 * de-duplicato. È il cuore condiviso di TRE porte: POST
 * /api/sessions/:sessionKey/move-to-project, il ripiego «tab di terminale»
 * di open-project / create-project, e il bind di una CHAT
 * (`bindTopicToProject`).
 *
 * `projectDir` DEVE essere già una cartella risolta ed esistente (i chiamanti
 * la risolvono con resolveProjectRef). I passi:
 *   1. togliere ogni pane dallo store standalone (`pane-store-v2`: la voce in
 *      `panes` più ogni riferimento in `groups.*.paneIds`), catturandone
 *      l'oggetto intero così che l'appartenenza al progetto porti la stessa
 *      forma — E scrivere per ognuna una TOMBSTONE durevole. L'idratazione del
 *      client è un'unione-con-tombstone (reducers/panes.ts
 *      HYDRATE_FROM_SNAPSHOT): qualunque pane locale che lo snapshot in arrivo
 *      non marchi in closedStack/tombstones viene TENUTA e ripersistita, quindi
 *      una rimozione nuda è impari contro i client vivi — il tab spostato
 *      tornava indietro e restava doppio standalone+progetto (chiudere l'uno
 *      uccideva la sessione condivisa, e sparivano insieme). La tombstone fa
 *      cadere l'unione dappertutto; una riapertura legittima la cancella
 *      (OPEN_PANE toglie la voce).
 *   2. aggiungerle all'appartenenza sincronizzata del progetto
 *      (`topics-project-panes-<projectHash(dir)>` → `nonChatPanes` /
 *      `openChatTopicIds`), in modo idempotente;
 *   3. persistere entrambe le scritture `ui_state` con un `server_seq`
 *      monotono fresco (BEGIN IMMEDIATE, così due scrittori non collidono sul
 *      seq) e mandarle in broadcast, così i client vivi convergono su UNA sola
 *      istanza.
 *
 * NON manda `open-project`: la messa a fuoco è del chiamante. La geometria
 * degli split (`project-layout-<hash>`), che è locale al dispositivo, non si
 * tocca.
 */
export function relocateIntoProject(
  db: Database,
  broadcastToAll: (msg: OutboundMessage) => void,
  req: RelocationRequest,
  projectDir: string,
): { membershipKey: string; movedPaneIds: string[]; movedTopicIds: string[] } {
  // Chiave di appartenenza: shared/project-keys.ts e' l'unica sorgente
  // dell'hash djb2 (client + server), cosi' la chiave combacia sempre con
  // quella che il renderer legge — non serve piu' un commento "MUST match".
  const membershipKey = projectPanesKey(projectDir);
  const panes = req.panes ?? [];
  const chatTopicIds = req.chatTopicIds ?? [];

  const readUi = (key: string): Record<string, unknown> | null => {
    const row = db.query("SELECT value FROM ui_state WHERE key = ?").get(key) as { value?: string } | undefined;
    if (!row?.value) return null;
    try { return JSON.parse(row.value) as Record<string, unknown>; } catch { return null; }
  };
  // Read-modify-write MUST be atomic: the reads below (APP_KEY, membershipKey)
  // and the writes run inside ONE `BEGIN IMMEDIATE` txn so a concurrent
  // ui-state PUT can't land between the read and the commit and get silently
  // reverted (this write always wins on server_seq regardless of when it
  // read). IMMEDIATE takes a RESERVED lock at txn start, so a second writer
  // blocks until we commit and then reads our updated rows. Mirrors the
  // single-transaction pattern in purgeTopicFromUiState.
  const stamped = db.transaction(() => {
    const writes: Array<{ key: string; value: unknown }> = [];

    // La pane di chat standalone ha l'id NUDO del topic sulle installazioni
    // vecchie e `chat:<id>` su quelle nuove (createPaneId). Si tolgono
    // entrambe le forme: sbagliarne una lascerebbe la chat duplicata fuori dal
    // progetto, che e' esattamente il difetto che questo modulo esiste per
    // chiudere.
    const chatPaneIds = chatTopicIds.flatMap((id) => [id, `chat:${id}`]);
    const spliceIds = new Set<string>([...panes.map((p) => p.id), ...chatPaneIds]);
    const captured = new Map<string, Record<string, unknown>>();

    // 1. Togliere le pane dallo store standalone, catturandone l'oggetto
    //    intero così che l'appartenenza al progetto porti la stessa forma.
    const app = readUi(APP_KEY);
    if (app) {
      const appPanes = app.panes as Record<string, Record<string, unknown>> | undefined;
      if (appPanes) {
        for (const id of spliceIds) {
          if (!appPanes[id]) continue;
          const { scrollOffset: _drop, ...rest } = appPanes[id];
          captured.set(id, rest);
          delete appPanes[id];
        }
      }
      const groups = app.groups as Record<string, { paneIds?: string[] }> | undefined;
      if (groups) {
        for (const g of Object.values(groups)) {
          if (g && Array.isArray(g.paneIds)) g.paneIds = g.paneIds.filter((x) => !spliceIds.has(x));
        }
      }
      // Durable removal marker — see the header. Shape mirrors the client's
      // `tombstones: Record<paneId, closedAt-ms>`; newest wins on merge.
      const tombs = (app.tombstones && typeof app.tombstones === "object"
        ? app.tombstones
        : {}) as Record<string, number>;
      const now = Date.now();
      // Solo cio' che c'era davvero: una tombstone su una pane mai aperta
      // qui non ripara niente e vieterebbe una futura apertura standalone.
      for (const id of spliceIds) if (captured.has(id)) tombs[id] = now;
      app.tombstones = tombs;
      writes.push({ key: APP_KEY, value: app });
    }

    // 2. Aggiungere pane e chat all'appartenenza del progetto (idempotente).
    const mem = (readUi(membershipKey) as { nonChatPanes?: unknown[]; openChatTopicIds?: unknown[] } | null)
      || { nonChatPanes: [], openChatTopicIds: [] };
    if (!Array.isArray(mem.nonChatPanes)) mem.nonChatPanes = [];
    if (!Array.isArray(mem.openChatTopicIds)) mem.openChatTopicIds = [];
    const movedPaneIds: string[] = [];
    for (const p of panes) {
      const shape = captured.get(p.id) ?? p.fallback;
      // Una pane che non era nello store standalone e non porta un ripiego non
      // si inventa: dichiararla al progetto con una forma indovinata
      // significherebbe un tab fantasma che non renderizza niente.
      if (!shape) continue;
      movedPaneIds.push(p.id);
      if (!mem.nonChatPanes.some((x) => (x as { id?: string })?.id === p.id)) {
        mem.nonChatPanes.push(shape);
      }
    }
    for (const topicId of chatTopicIds) {
      if (!mem.openChatTopicIds.includes(topicId)) mem.openChatTopicIds.push(topicId);
    }
    writes.push({ key: membershipKey, value: mem });

    // 3. Persist with fresh monotonic server_seq each, then return them for
    //    broadcast after the txn commits.
    const out: Array<{ key: string; value: unknown; seq: number }> = [];
    for (const w of writes) {
      const { maxSeq } = db.query("SELECT COALESCE(MAX(server_seq), 0) AS maxSeq FROM ui_state").get() as { maxSeq: number };
      const seq = maxSeq + 1;
      db.run(
        `INSERT INTO ui_state (key, value, payload_version, server_seq, updated_at)
         VALUES (?, ?, 2, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value, payload_version = 2,
           server_seq = excluded.server_seq, updated_at = datetime('now')`,
        [w.key, JSON.stringify(w.value), seq],
      );
      out.push({ key: w.key, value: w.value, seq });
    }
    return { writes: out, movedPaneIds };
  }).immediate() as { writes: Array<{ key: string; value: unknown; seq: number }>; movedPaneIds: string[] };

  for (const s of stamped.writes) {
    broadcastToAll({ type: "ui-state:updated", key: s.key, value: s.value, payload_version: 2, server_seq: s.seq });
  }
  return { membershipKey, movedPaneIds: stamped.movedPaneIds, movedTopicIds: [...chatTopicIds] };
}

/**
 * Il tab di terminale: non ha un topic di chat, quindi `bindTopicToProject` non
 * può spostarlo — la pane vive nello store a livello di app, non dentro un
 * topic. Se non è (ancora) nello store standalone si dichiara comunque al
 * progetto con la forma minima di un tab Claude Code.
 */
export function moveTerminalPaneToProject(
  db: Database,
  broadcastToAll: (msg: OutboundMessage) => void,
  term: { id: string; name?: string },
  projectDir: string,
): { paneId: string; membershipKey: string } {
  const paneId = `terminal:${term.id}`;
  const { membershipKey } = relocateIntoProject(
    db,
    broadcastToAll,
    {
      panes: [{
        id: paneId,
        fallback: { id: paneId, type: "terminal", title: term.name || "Claude Code", preview: false, terminalType: "claude-code" },
      }],
    },
    projectDir,
  );
  return { paneId, membershipKey };
}

/**
 * Una CHAT che entra in un progetto si porta dietro le sue superfici.
 *
 * `bindTopicToProject` scriveva solo `projectPath` e suggeriva la messa a
 * fuoco: il resto — far comparire la chat fra i tab del progetto, e portarci
 * dentro il suo pannello browser — dipendeva da un client vivo che raccogliesse
 * il suggerimento. Se non c'era (finestra chiusa, un altro dispositivo, la
 * risposta finita mentre nessuno guardava) la chat finiva in mezzo al guado:
 * fuori dallo standalone, perché ormai appartiene a un progetto, e dentro a
 * nessun progetto, perché nessuno l'aveva scritta nell'appartenenza. Il browser
 * restava fuori comunque, come un tab orfano di una chat che non c'è più
 * (card 76b0058b).
 *
 * `browserContextIds` sono i contesti browser della topic
 * (`topic.browserState?.contextId ?? topic.id`): le pane corrispondenti
 * esistono solo se erano davvero aperte, e quelle assenti si saltano.
 */
export function moveTopicToProject(
  db: Database,
  broadcastToAll: (msg: OutboundMessage) => void,
  topic: { id: string; browserContextIds?: string[] },
  projectDir: string,
): { membershipKey: string; movedPaneIds: string[] } {
  const { membershipKey, movedPaneIds } = relocateIntoProject(
    db,
    broadcastToAll,
    {
      chatTopicIds: [topic.id],
      panes: (topic.browserContextIds ?? []).map((ctx) => ({ id: `browser:${ctx}` })),
    },
    projectDir,
  );
  return { membershipKey, movedPaneIds };
}
