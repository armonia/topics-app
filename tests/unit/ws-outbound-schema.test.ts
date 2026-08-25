/**
 * Unit tests for the outbound WS message registry (v3 foundations WS-01
 * emit-side validation).
 *
 * Run with: `bun test tests/unit/ws-outbound-schema.test.ts`
  * @covers WIRE-07
 */
import { describe, expect, test } from 'bun:test';
import {
  validateOutbound,
  isRegisteredOutboundType,
  REGISTERED_OUTBOUND_TYPES,
} from '../../shared/ws-outbound';

// ----- Registered types: round-trip valid payloads --------------------------

describe('validateOutbound — valid registered messages', () => {
  const validPayloads: Array<Record<string, unknown>> = [
    { type: 'connected', clientId: 'ws-abc' },
    { type: 'pong' },
    { type: 'dashboard:updated' },
    {
      type: 'unread:init',
      data: {
        'topic-1': { lastReadAt: '2026-05-13T00:00:00Z', unreadCount: 0 },
        'topic-2': { lastReadAt: '2026-05-13T01:00:00Z', unreadCount: 3 },
      },
    },
    { type: 'unread:updated', topicId: 'topic-1', unreadCount: 5 },
    { type: 'stream:end', sessionKey: 'sk-1', messageId: 'm-1' },
    { type: 'typing', topicId: 'topic-1', clientId: 'ws-1', text: 'hello' },
    { type: 'typing', topicId: 'topic-1', clientId: 'ws-1', text: '' },
    { type: 'drag:start', topicId: 'topic-1', sourceWindowId: 'win-1' },
    { type: 'drag:end', topicId: 'topic-1', sourceWindowId: 'win-1' },
    { type: 'drag:accepted', topicId: 'topic-1', targetWindowId: 'win-2' },
    {
      type: 'drag:accepted',
      topicId: 'topic-1',
      targetWindowId: 'win-2',
      sourceWindowId: 'win-1',
    },
    {
      type: 'topic:switch',
      fromTopicId: 'topic-1',
      fromSessionKey: 'sk-1',
      toTopicId: 'topic-2',
      toSessionKey: 'sk-2',
    },
  ];

  for (const payload of validPayloads) {
    test(`validates ${payload.type as string}`, () => {
      expect(validateOutbound(payload).ok).toBe(true);
    });
  }
});

// ----- Registered types: rejection on bad payloads --------------------------

describe('validateOutbound — malformed registered messages', () => {
  test('rejects connected without clientId', () => {
    const r = validateOutbound({ type: 'connected' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('clientId');
  });

  test('rejects unread:updated with wrong type for unreadCount', () => {
    const r = validateOutbound({ type: 'unread:updated', topicId: 't', unreadCount: 'many' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unreadCount');
  });

  test('rejects stream:end missing sessionKey', () => {
    const r = validateOutbound({ type: 'stream:end', messageId: 'm-1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('sessionKey');
  });

  test('rejects typing missing clientId', () => {
    const r = validateOutbound({ type: 'typing', topicId: 't', text: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('clientId');
  });

  test('rejects topic:switch missing toSessionKey', () => {
    const r = validateOutbound({ type: 'topic:switch', fromTopicId: 'a', toTopicId: 'b' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('toSessionKey');
  });

  test('rejects unread:init with wrong nested shape', () => {
    const r = validateOutbound({
      type: 'unread:init',
      data: { 'topic-1': { lastReadAt: 0, unreadCount: 'oops' } },
    });
    expect(r.ok).toBe(false);
  });
});

// ----- Unmodeled types: passthrough -----------------------------------------

describe('validateOutbound — unmodeled types passthrough', () => {
  test('returns ok for types not in the registry', () => {
    // After the Day-3 expansion the registry covers virtually all emitted
    // outbound types. These synthetic placeholders exercise the
    // passthrough path for types that may appear in a future deploy
    // before the schema lands.
    expect(validateOutbound({ type: 'future.unknown.event' }).ok).toBe(true);
    expect(validateOutbound({ type: 'totally-new-event' }).ok).toBe(true);
  });

  test('a type not in registry passes even with extra/missing fields', () => {
    // The registry is opt-in; unmodeled types accept any shape until they
    // get a schema. Promote a type by adding to OUTBOUND_SCHEMAS — adding
    // a schema will start rejecting bad payloads without breaking other
    // types.
    expect(validateOutbound({ type: 'random-event', a: 1, b: 'x' }).ok).toBe(true);
  });
});

// ----- Hard-rejects: structural issues --------------------------------------

describe('validateOutbound — structural rejects', () => {
  test('rejects non-object', () => {
    expect(validateOutbound(null).ok).toBe(false);
    expect(validateOutbound(undefined).ok).toBe(false);
    expect(validateOutbound(42).ok).toBe(false);
    expect(validateOutbound('hello').ok).toBe(false);
  });

  test('rejects missing type field', () => {
    const r = validateOutbound({ data: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('type');
  });

  test('rejects non-string type', () => {
    const r = validateOutbound({ type: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('type');
  });
});

// ----- Registry contract guard ---------------------------------------------

describe('outbound registry contract', () => {
  test('REGISTERED_OUTBOUND_TYPES is the locked v3 v1 set', () => {
    // Adding a type to OUTBOUND_SCHEMAS requires updating this assertion.
    // That's intentional — it forces the PR author to acknowledge that
    // the outbound surface grew (and to document it in WS-PROTOCOL.md).
    //
    // 2026-08-05, −12 → tutta la famiglia `agent:*` / `agents:*`: profili,
    // assegnazioni, heartbeat, escalation e il roster di sessioni di OpenClaw.
    // Un agente è il provider che hai scelto, non un personaggio con un nome, e
    // i sotto-agenti di un turno sono sessioni di terminale con un
    // `parentSessionKey` — viaggiano sui frame `terminal:*`.
    //
    // 2026-08-09, +1 → `task:awaiting-human`: un task che aspetta una persona.
    // Aggiunto da `e8cf7799` («L'attesa è un evento, non una colonna: il chip
    // persistito congelava il task») insieme al suo schema e ai suoi test, ma
    // senza il conteggio — e il conteggio è proprio ciò che obbliga a guardare
    // che la superficie in uscita è cresciuta. Guardato: è un evento, non uno
    // stato persistito, ed è per questo che viaggia come frame.
    //
    // 2026-07-30, +1 → `stream:usage`: il CONSUMO del turno mentre cresce.
    // Fratello di `stream:context` e distinto da lui apposta — quello è il
    // serbatoio (sale e SCENDE con le compattazioni), questo è la bolletta (solo
    // cresce). Prima i numeri di consumo arrivavano una volta sola, a turno
    // finito: in un turno agentico da otto tool call non si vedeva muovere
    // niente. Non si poteva allargare `stream:context` senza far dire a un
    // evento due cose che si muovono in verso opposto.
    expect(REGISTERED_OUTBOUND_TYPES).toEqual([
      'auth:device-revoked',
      'auth:pair-requested',
      'auth:pair-resolved',
      'auth:shares-changed',
      'board:dispatch',
      'board:global-cap',
      'board:settings',
      'browser:close-pane',
      'browser:focus-pane',
      'browser:force-open',
      'browser:navigate',
      'browser:open-near-pane',
      'browser:open-task-tab',
      'clear',
      'connected',
      'cron:updated',
      'dashboard:updated',
      'drag:accepted',
      'drag:end',
      'drag:start',
      'error',
      'external-sessions',
      'files:changed',
      'gateway:status',
      'git:status',
      'goal:updated',
      'machine:deleted',
      'machine:updated',
      'machine:upserted',
      'memory:updated',
      'message',
      'message:media',
      'message:new',
      'notification:new',
      'notification:seen',
      'open-project',
      'pane:focus-suggest',
      'pong',
      'presence:windows',
      'project:archived',
      'project:deleted',
      'project:new',
      'project:updated',
      'providers:snapshot',
      'scripts:output',
      'scripts:updated',
      'session:state',
      'stream:catchup',
      'stream:compaction',
      'stream:content_chunk',
      'stream:context',
      'stream:end',
      'stream:error',
      'stream:resumed',
      'stream:slow',
      'stream:start',
      'stream:thinking_chunk',
      'stream:thinking_end',
      'stream:thinking_start',
      'stream:tool_call',
      'stream:tool_detail',
      // Un permesso non è una domanda: evento suo, e simmetrico —
      // `required` porta cosa si chiede, `resolved` cosa è stato deciso.
      // Senza il secondo, un client che riceveva solo `stream:tool_update`
      // (che porta il solo `partialResult`) vedeva sparire il pannello e
      // non sapeva COSA fosse stato deciso fino al reload.
      'stream:tool_permission_required',
      'stream:tool_permission_resolved',
      'stream:tool_result',
      'stream:tool_update',
      'stream:tool_usage',
      'stream:tool_user_input_required',
      'stream:usage',
      'task:awaiting-human',
      'task:created',
      'task:deleted',
      'task:parked',
      'task:review-ready',
      'task:updated',
      'task:usage-live',
      'terminal:activity',
      'terminal:sessions',
      'topic:archived',
      'topic:created',
      'topic:switch',
      'topic:switch:complete',
      'topic:updated',
      'topics:reordered',
      'typing',
      'ui-state:init',
      'ui-state:patch',
      'ui-state:updated',
      'ui:bundle-rev',
      'ui:bundle-updated',
      'unread:init',
      'unread:updated',
      'welcome',
      'worktree:deleted',
      'worktree:new',
      'worktree:updated',
    ]);
  });

  test('isRegisteredOutboundType matches the registry', () => {
    for (const t of REGISTERED_OUTBOUND_TYPES) {
      expect(isRegisteredOutboundType(t)).toBe(true);
    }
    expect(isRegisteredOutboundType('not-yet-modeled')).toBe(false);
  });

  // presence:windows joined the outbound registry in 724284d3 (cross-window
  // presence protocol), taking the count from 81 → 82; browser:close-pane
  // joined with the remote pane-close capability (PR #8), 82 → 83;
  // browser:focus-pane joined with the "manage any tab" capability, 83 → 84;
  // stream:context joined with the real-context ring (1b.5) — the honest
  // input+cache_read+cache_creation of the last call, finally on the wire
  // instead of dying inside the compaction backfill, 84 → 85.
  //
  // 85 → 101 (3.3): non tipi NUOVI, ma i 16 che il server emetteva già SENZA
  // schema — l'inventario dei punti di emissione li ha tirati fuori tutti in
  // una volta (board:*, task:*, browser:open-*, pane:focus-suggest,
  // machine:deleted, terminal:activity, stream:compaction, ui:bundle-*).
  // Da qui in poi il buco non si riapre: `ws-outbound-coverage.test.ts`
  // fallisce se un broadcast nuovo arriva senza il suo schema.
  //
  // 101 → 102: `external-sessions`. Non l'ha trovato lo scan statico ma il
  // COMPILATORE, quando `broadcast()` ha smesso di accettare `object` e ha
  // preteso un `type` del registro: il nome non ha i due punti, quindi la
  // regex dell'inventario lo scartava. È la prova che il vincolo di tipo
  // vede cose che una regex non può vedere.
  // 102 → 103: `goal:updated` (3.4). Il goal di una chat è l'unico stato che
  // l'envelope re-inietta a ogni turno: se la barra in cima alla chat non lo
  // seguisse dal vivo, due finestre sulla stessa topic mostrerebbero obiettivi
  // diversi mentre il modello ne vede uno solo.
  // 103 → 102: via `message:plan-status`. L'endpoint che lo emetteva
  // (`POST /api/topics/:id/messages/:msgId/plan-status`) non aveva un solo
  // consumatore — 0 client, 0 su 6293 messaggi con un `plan_status` scritto —
  // ed era il residuo di un'approvazione dei piani mai collegata: oggi il Plan
  // Mode passa da `opts.planMode` e l'approvazione la gestisce la CLI. La
  // COLONNA resta, perché è intrecciata in ogni CRUD dei messaggi.
  // 102 → 95: via sette schemi che NESSUNO mandava e NESSUNO ascoltava — i
  // quattro `chat:*` (created/updated/archived/deleted), `provider:current`,
  // `provider:changed` e `agent:status`. Un registro di protocollo che dichiara
  // messaggi inesistenti fa credere che una via di sincronizzazione ci sia; il
  // ciclo di vita delle chat passa da `topic:*`, che è vivo. Il test di
  // copertura difende il verso opposto (un broadcast senza schema), quindi
  // questi non erano difesi da niente.
  // 95 → 96: entra `task:parked`, il gemello di fallimento di
  // `task:review-ready`. Il park terminale (l'agente si arrende, il task NON
  // riparte da solo) era l'unico esito di un dispatch che non aveva un fronte:
  // il task restava fermo in silenzio finché non lo si andava a guardare.
  // 96 → 97: entra `stream:tool_usage`, il consumo attribuito alla SINGOLA
  // azione. `stream:context` racconta il serbatoio e `stream:usage` la bolletta
  // del turno intero: nessuno dei due sa dire quale tool call è costata. Ha
  // mittente (`server/routes/chat.ts`) e ascoltatore (`useChat`), quindi non è
  // un tipo dichiarativo — è il contratto di una via che esiste.
  // 85 → 86: entra `files:changed`, l'evento del watcher del filesystem di
  // progetto. Prima l'albero dei file era una FOTOGRAFIA: `loadFiles` girava al
  // montaggio, sul bottone Aggiorna, e dopo le mutazioni fatte dall'Explorer
  // stesso — quindi ogni file creato da un agente restava invisibile. E lo era
  // in modo visibilmente asimmetrico, perché nella stessa sidebar i numeri di
  // git si muovevano da soli: un watcher su `.git` c'era da sempre.
  // 86 → 89: entrano i tre `auth:*` dell'accoppiamento di un dispositivo —
  // `pair-requested` (un telefono bussa e mostra un codice), `pair-resolved`
  // (qualcuno da questa parte ha detto sì o no) e `device-revoked`. Sono
  // l'unico stato in cui la decisione sta su UNA macchina e l'effetto su
  // un'altra: senza un fronte, il dispositivo che chiede resta a fissare uno
  // schermo fermo finché non ricarica. Tutti e tre hanno mittente
  // (`server/routes/auth.ts`) e ascoltatore (`useWebSocket`) — verificato, non
  // sono tipi dichiarativi.
  // 89 → 90: entra `auth:shares-changed`, che chiude il buco lasciato dai tre
  // qui sopra. Quelli coprono l'ACCESSO (chi entra); questo copre le
  // CONCESSIONI (cosa vedi una volta dentro): finché non c'era, condividere una
  // scheda con un ospite non gli si vedeva arrivare — l'unico segnale che
  // `GuestView` ascoltava era un evento di pairing, quindi restava a guardare
  // un elenco vecchio finché non premeva Ricarica. Sembrava latenza, era un
  // canale mancante.
  //
  // Non porta la risorsa, ed è deliberato: sulla REVOCA la concessione non
  // esiste più, quindi un filtro per entità scarterebbe proprio il frame che
  // serve di più. Per lo stesso motivo viaggia MIRATO (`ctx.sendToDevice`) e
  // non in broadcast. Mittente `server/routes/auth.ts`, ascoltatore
  // `useWebSocket` → `GuestView`.
  // 93 → 95: entrano `notification:new` e `notification:seen`, i due fronti
  // della CRONOLOGIA delle notifiche (migration 101). Non sono un doppione dei
  // fronti che già esistono: `task:review-ready` & co. dicono «è successa una
  // cosa», questi dicono «è stata NOTIFICATA, ecco la riga e il conteggio».
  // Servono perché il contatore accanto a Topics è per definizione live, e
  // perché il «visto» è globale: guardare la lista su una finestra deve
  // spegnere il pallino sulle altre — senza un fronte ognuna resterebbe col suo
  // numero fino al ricaricamento. Mittente `server/routes/notifications.ts`,
  // ascoltatore `useNotificationHistory`.
  test('all 95 v3 outbound types are present', () => {
    expect(REGISTERED_OUTBOUND_TYPES.length).toBe(95);
  });
});

describe('validateOutbound — final 100% coverage cluster', () => {

  // Payload copiato dal call site: services/external-sessions.ts → sweep().
  test('external-sessions carries the census and the per-project rollup', () => {
    expect(validateOutbound({
      type: 'external-sessions',
      sessions: [{
        sessionId: 's-1',
        cwd: '/Users/x/Projects/topics-app',
        projectPath: '/Users/x/Projects/topics-app',
        projectId: 'p-1',
        branch: 'main',
        entrypoint: 'cli',
        lastActivityMs: 1_700_000_000_000,
        state: 'active',
        transcriptPath: '/Users/x/.claude/projects/foo/s-1.jsonl',
      }],
      projects: [{
        projectId: 'p-1',
        projectPath: '/Users/x/Projects/topics-app',
        total: 2,
        active: 1,
        lastActivityMs: 1_700_000_000_000,
      }],
      payload_version: 1,
    }).ok).toBe(true);
    // Il censimento vuoto è legittimo: nessuna sessione esterna aperta.
    expect(validateOutbound({
      type: 'external-sessions', sessions: [], projects: [], payload_version: 1,
    }).ok).toBe(true);
    // `projectPath`/`projectId` sono nullable (sessione non attribuita), non assenti.
    expect(validateOutbound({
      type: 'external-sessions',
      sessions: [{
        sessionId: 's-2', cwd: '/tmp', projectPath: null, projectId: null,
        lastActivityMs: 1, state: 'idle',
      }],
      projects: [],
    }).ok).toBe(true);
    // Lo stato è un enum chiuso: 'running' non esiste in questo censimento.
    expect(validateOutbound({
      type: 'external-sessions',
      sessions: [{
        sessionId: 's-3', cwd: '/tmp', projectPath: null, projectId: null,
        lastActivityMs: 1, state: 'running',
      }],
      projects: [],
    }).ok).toBe(false);
    // `sessions` è obbligatorio: il client fa `Array.isArray(m.sessions)`, ma
    // un broadcast senza censimento è comunque un bug del server.
    expect(validateOutbound({ type: 'external-sessions', projects: [] }).ok).toBe(false);
  });

  test('provider:current/changed minimal payload', () => {
    expect(validateOutbound({ type: 'provider:current' }).ok).toBe(true);
    expect(validateOutbound({ type: 'provider:changed', name: 'claude' }).ok).toBe(true);
  });

  test('git:status minimal payload (passthrough)', () => {
    expect(validateOutbound({ type: 'git:status' }).ok).toBe(true);
    expect(validateOutbound({
      type: 'git:status', projectId: 'p-1', dirty: true,
    }).ok).toBe(true);
  });
});

// ----- Day-3 additions: approval + stream + message + misc ---------------
//
// Il cluster `agent:*` / `agents:*` non c'è più: profili, assegnazioni,
// heartbeat e il roster di sessioni di OpenClaw sono usciti dal registro
// insieme alle loro pane (vedi la lista bloccata qui sopra).

describe('validateOutbound — stream cluster', () => {
  test('stream:start requires sessionKey + messageId', () => {
    expect(validateOutbound({
      type: 'stream:start', sessionKey: 'sk', messageId: 'm-1',
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'stream:start', sessionKey: 'sk', messageId: 'm-1', topicId: 't-1',
    }).ok).toBe(true);
  });

  test('stream:content_chunk requires content string', () => {
    expect(validateOutbound({
      type: 'stream:content_chunk', sessionKey: 'sk', content: 'hi',
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'stream:content_chunk', sessionKey: 'sk', content: 42,
    }).ok).toBe(false);
  });

  test('stream:error requires error string', () => {
    expect(validateOutbound({
      type: 'stream:error', sessionKey: 'sk', error: 'boom',
    }).ok).toBe(true);
  });

  test('stream:tool_call requires toolCall.id', () => {
    expect(validateOutbound({
      type: 'stream:tool_call', sessionKey: 'sk',
      toolCall: { id: 'tc-1', name: 'Bash', args: {} },
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'stream:tool_call', sessionKey: 'sk',
      toolCall: { name: 'Bash' }, // missing id
    }).ok).toBe(false);
  });

  test('stream:thinking_start/end accepts minimal payload', () => {
    expect(validateOutbound({ type: 'stream:thinking_start', sessionKey: 'sk' }).ok).toBe(true);
    expect(validateOutbound({ type: 'stream:thinking_end', sessionKey: 'sk' }).ok).toBe(true);
  });

  test('stream:tool_user_input_required accepts minimal payload', () => {
    expect(validateOutbound({
      type: 'stream:tool_user_input_required', sessionKey: 'sk',
    }).ok).toBe(true);
  });
});

describe('validateOutbound — message cluster', () => {
  test('message (legacy) requires message.id', () => {
    expect(validateOutbound({
      type: 'message', sessionKey: 'sk',
      message: { id: 'm-1', role: 'assistant', content: 'hi' },
    }).ok).toBe(true);
  });

  test('message:new requires sessionKey, role, messageId, content', () => {
    expect(validateOutbound({
      type: 'message:new', sessionKey: 'sk', topicId: 't-1', role: 'assistant',
      messageId: 'm-1', content: 'hello',
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'message:new', sessionKey: 'sk', role: 'user', messageId: 'm-1',
      content: 'hi', // topicId optional, preview optional
    }).ok).toBe(true);
  });

  test('message:media accepts arbitrary media field', () => {
    expect(validateOutbound({
      type: 'message:media', sessionKey: 'sk', media: ['url1', 'url2'],
    }).ok).toBe(true);
  });
});

describe('validateOutbound — misc domain (browser/cron/machine/memory/open-project/etc)', () => {
  test('browser:navigate requires topicId + url', () => {
    expect(validateOutbound({
      type: 'browser:navigate', topicId: 't-1', url: 'https://x',
    }).ok).toBe(true);
    expect(validateOutbound({ type: 'browser:navigate', topicId: 't-1' }).ok).toBe(false);
  });

  test('clear is minimal', () => {
    expect(validateOutbound({ type: 'clear' }).ok).toBe(true);
  });

  test('cron:updated requires jobs array', () => {
    expect(validateOutbound({ type: 'cron:updated', jobs: [] }).ok).toBe(true);
    expect(validateOutbound({ type: 'cron:updated' }).ok).toBe(false);
  });

  test('machine:upserted/updated require machine.id', () => {
    expect(validateOutbound({
      type: 'machine:upserted', machine: { id: 'm-1', name: 'mbp' },
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'machine:updated', machine: { id: 'm-1', last_seen: '2026' },
    }).ok).toBe(true);
  });

  test('memory:updated requires scope', () => {
    expect(validateOutbound({ type: 'memory:updated', scope: 'global' }).ok).toBe(true);
    expect(validateOutbound({
      type: 'memory:updated', scope: 'topic', topicId: 't-1',
    }).ok).toBe(true);
    expect(validateOutbound({ type: 'memory:updated' }).ok).toBe(false);
  });

  test('open-project requires projectPath', () => {
    expect(validateOutbound({ type: 'open-project', projectPath: '/Users/me/proj' }).ok).toBe(true);
    expect(validateOutbound({ type: 'open-project' }).ok).toBe(false);
  });

  test('topics:reordered requires order array of strings', () => {
    expect(validateOutbound({
      type: 'topics:reordered', order: ['t-1', 't-2'],
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'topics:reordered', order: [1, 2],
    }).ok).toBe(false);
  });


  test('ui-state:init accepts data + optional meta', () => {
    expect(validateOutbound({
      type: 'ui-state:init', data: { keys: {} }, meta: { server_seq: 1 },
    }).ok).toBe(true);
    expect(validateOutbound({ type: 'ui-state:init', data: {} }).ok).toBe(true);
  });

  test('welcome (outbound echo) requires all fields', () => {
    expect(validateOutbound({
      type: 'welcome',
      serverVersion: '1.0.0', protocolVersion: 1,
      capabilities: ['ws-validation-v1'], serverTime: 1700000000000,
      clientId: 'ws-abc',
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'welcome', serverVersion: '1.0', protocolVersion: 1.5,
      capabilities: [], serverTime: 0, clientId: '',
    }).ok).toBe(false); // protocolVersion must be integer
  });
});

// ----- New schema coverage (clusters added 2026-05-13) ---------------------

describe('validateOutbound — topic cluster', () => {
  test('topic:created with id-bearing topic', () => {
    expect(validateOutbound({
      type: 'topic:created',
      topic: { id: 'topic-1', sessionKey: 'topic:abc', color: '#5865f2' },
    }).ok).toBe(true);
  });

  test('topic:updated with topic', () => {
    expect(validateOutbound({
      type: 'topic:updated',
      topic: { id: 'topic-1', sessionKey: 'topic:abc' },
    }).ok).toBe(true);
  });

  test('topic:archived requires topic.id', () => {
    expect(validateOutbound({
      type: 'topic:archived',
      topic: { color: '#fff' },
    }).ok).toBe(false);
  });

  test('topic:switch:complete passthrough', () => {
    expect(validateOutbound({ type: 'topic:switch:complete', anyField: 1 }).ok).toBe(true);
  });
});

describe('validateOutbound — worktree cluster', () => {
  test('worktree:new + payload_version', () => {
    expect(validateOutbound({
      type: 'worktree:new',
      worktree: { id: 'wt-1', name: 'foo', branch: 'feat' },
      payload_version: 1,
    }).ok).toBe(true);
  });

  test('worktree:updated tolerates payload_version absent', () => {
    expect(validateOutbound({
      type: 'worktree:updated',
      worktree: { id: 'wt-1', status: 'ready' },
    }).ok).toBe(true);
  });

  test('worktree:deleted accepts minimal payload', () => {
    expect(validateOutbound({
      type: 'worktree:deleted',
      worktree: { id: 'wt-1' },
    }).ok).toBe(true);
  });
});

describe('validateOutbound — ui-state cluster', () => {
  test('ui-state:updated with all canonical fields', () => {
    expect(validateOutbound({
      type: 'ui-state:updated',
      key: 'window-1',
      value: { panes: [] },
      payload_version: 2,
      server_seq: 42,
      sourceClientId: 'ws-abc',
    }).ok).toBe(true);
  });

  test('ui-state:patch with entries array', () => {
    expect(validateOutbound({
      type: 'ui-state:patch',
      sourceClientId: 'ws-abc',
      entries: [{ key: 'k', op: 'set', value: 1 }],
    }).ok).toBe(true);
  });

  test('ui-state:updated rejects missing key', () => {
    expect(validateOutbound({ type: 'ui-state:updated', value: 1 }).ok).toBe(false);
  });
});

describe('validateOutbound — project + provider + error', () => {
  test('project:new with payload_version', () => {
    expect(validateOutbound({
      type: 'project:new',
      project: { id: 'p-1', name: 'Demo' },
      payload_version: 1,
    }).ok).toBe(true);
  });

  test('providers:snapshot with arbitrary snapshot shape', () => {
    expect(validateOutbound({
      type: 'providers:snapshot',
      snapshot: { current: 'claude', list: ['claude', 'openai'] },
    }).ok).toBe(true);
  });

  test('error envelope requires message', () => {
    expect(validateOutbound({ type: 'error', message: 'failed' }).ok).toBe(true);
    expect(validateOutbound({ type: 'error' }).ok).toBe(false);
  });

  test('stream:catchup minimal payload', () => {
    expect(validateOutbound({
      type: 'stream:catchup',
      sessionKey: 'sk-1',
      messageId: 'm-1',
    }).ok).toBe(true);
  });
});

// ----- Tipi modellati nel giro 3.3 ------------------------------------------
//
// I payload qui sotto sono COPIATI dai punti di emissione reali (routes/tasks,
// routes/topics, routes/terminal, routes/chat, services/task-dispatcher,
// lib/dev-bundle-reload): se un giorno il server cambia forma senza aggiornare
// lo schema, uno di questi diventa rosso qui invece che in produzione.

describe('validateOutbound — board + task', () => {
  const task = {
    id: 't-1', projectId: 'p-1', text: 'Fai la cosa', status: 'review',
    priority: 0, kanbanOrder: 1, createdAt: '2026-07-28T10:00:00Z',
  };

  test('task:created / task:updated con la riga completa', () => {
    expect(validateOutbound({ type: 'task:created', projectId: 'p-1', task }).ok).toBe(true);
    expect(validateOutbound({ type: 'task:updated', projectId: 'p-1', task }).ok).toBe(true);
  });

  test('task:updated rifiuta un task senza status (la colonna kanban)', () => {
    expect(validateOutbound({
      type: 'task:updated', projectId: 'p-1', task: { id: 't-1', projectId: 'p-1' },
    }).ok).toBe(false);
  });

  test('task:deleted porta solo l’id', () => {
    expect(validateOutbound({ type: 'task:deleted', projectId: 'p-1', taskId: 't-1' }).ok).toBe(true);
  });

  test('task:review-ready con e senza reason', () => {
    expect(validateOutbound({
      type: 'task:review-ready', projectId: 'p-1', taskId: 't-1', taskTitle: 'Fai la cosa',
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'task:review-ready', projectId: 'p-1', taskId: 't-1', taskTitle: 'Fai la cosa',
      reason: 'agent_delivered',
    }).ok).toBe(true);
  });

  // Lo `state` è chiuso di proposito: sono i TRE park terminali del dispatcher
  // (`failed` = l'agente si è arreso, `blocked` = serve una mano umana,
  // `waited_out` = la serie di attese dichiarate ha sfondato il tetto). Un
  // quarto valore vorrebbe dire che qualcuno ha aggiunto un esito senza decidere
  // che fronte mostrargli: la copy del banner e della push si legge di qui, e
  // un esito senza copy propria eredita quella di un altro.
  test('task:parked accetta failed, blocked e waited_out, rifiuta il resto', () => {
    expect(validateOutbound({
      type: 'task:parked', projectId: 'p-1', taskId: 't-1', taskTitle: 'Fai la cosa', state: 'failed',
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'task:parked', projectId: 'p-1', taskId: 't-1', taskTitle: 'Fai la cosa',
      state: 'blocked', reason: 'max_turns',
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'task:parked', projectId: 'p-1', taskId: 't-1', taskTitle: 'Fai la cosa', state: 'waited_out',
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'task:parked', projectId: 'p-1', taskId: 't-1', taskTitle: 'Fai la cosa', state: 'queued',
    }).ok).toBe(false);
    expect(validateOutbound({
      type: 'task:parked', projectId: 'p-1', taskId: 't-1', taskTitle: 'Fai la cosa', state: 'waiting',
    }).ok).toBe(false);
    expect(validateOutbound({
      type: 'task:parked', projectId: 'p-1', taskId: 't-1', taskTitle: 'Fai la cosa',
    }).ok).toBe(false);
  });

  test('task:usage-live accetta model null (turno senza modello noto)', () => {
    expect(validateOutbound({
      type: 'task:usage-live', projectId: 'p-1', taskId: 't-1',
      turnStartedAt: 1753700000000, baseMs: 12000, liveTokens: 4210, model: null,
    }).ok).toBe(true);
  });

  test('task:usage-live — `triage` è facoltativo, ma se c\'è è un booleano', () => {
    // Facoltativo perché le due metà invecchiano separate: un guscio più vecchio
    // del server non lo conosce, un server più vecchio del client non lo manda.
    const base = {
      type: 'task:usage-live', projectId: 'p-1', taskId: 't-1',
      turnStartedAt: 1753700000000, baseMs: 0, liveTokens: 0, model: 'opus',
    };
    expect(validateOutbound({ ...base, triage: true }).ok).toBe(true);
    expect(validateOutbound({ ...base, triage: false }).ok).toBe(true);
    expect(validateOutbound({ ...base, triage: 'si' }).ok).toBe(false);
  });

  test('board:global-cap — maxAgentsAuto è un BOOLEANO, non un numero', () => {
    expect(validateOutbound({ type: 'board:global-cap', maxAgentsAuto: true, maxAgents: 3 }).ok).toBe(true);
    expect(validateOutbound({ type: 'board:global-cap', maxAgentsAuto: 3, maxAgents: 3 }).ok).toBe(false);
  });

  test('board:dispatch e board:settings', () => {
    expect(validateOutbound({ type: 'board:dispatch', autoDispatch: false }).ok).toBe(true);
    expect(validateOutbound({ type: 'board:dispatch', autoDispatch: 'no' }).ok).toBe(false);
    expect(validateOutbound({
      type: 'board:settings', projectId: 'p-1', settings: { autoDispatch: true, dispatchTimeoutMin: 20 },
    }).ok).toBe(true);
  });
});

describe('validateOutbound — browser, pane, terminale, macchine', () => {
  test('browser:open-near-pane con contextId opzionale', () => {
    expect(validateOutbound({
      type: 'browser:open-near-pane', paneId: 'terminal:s-1', url: 'https://x.dev',
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'browser:open-near-pane', paneId: 'terminal:s-1', contextId: 'term-s-1',
      url: 'https://x.dev',
    }).ok).toBe(true);
  });

  test('browser:open-task-tab richiede taskId e contextId', () => {
    expect(validateOutbound({
      type: 'browser:open-task-tab', taskId: 't-1', contextId: 'task-abc12345-1', url: 'https://x.dev',
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'browser:open-task-tab', taskId: 't-1', url: 'https://x.dev',
    }).ok).toBe(false);
  });

  test('pane:focus-suggest — topicId obbligatorio, il resto no', () => {
    expect(validateOutbound({ type: 'pane:focus-suggest', topicId: 'topic-1' }).ok).toBe(true);
    expect(validateOutbound({
      type: 'pane:focus-suggest', topicId: 'topic-1', projectPath: '/Users/x/proj', taskId: 't-1',
    }).ok).toBe(true);
    expect(validateOutbound({ type: 'pane:focus-suggest', projectPath: '/Users/x/proj' }).ok).toBe(false);
  });

  test('terminal:activity nelle tre forme che il server manda', () => {
    expect(validateOutbound({ type: 'terminal:activity', id: 's-1', busy: true, kind: 'claude-code' }).ok).toBe(true);
    expect(validateOutbound({
      type: 'terminal:activity', id: 's-1', busy: false, finished: true, kind: 'shell',
    }).ok).toBe(true);
    expect(validateOutbound({ type: 'terminal:activity', id: 's-1', busy: false }).ok).toBe(true);
    expect(validateOutbound({ type: 'terminal:activity', id: 's-1', busy: false, kind: 'browser' }).ok).toBe(false);
  });

  test('machine:deleted incarta { id } sotto `machine` come gli altri machine:*', () => {
    expect(validateOutbound({ type: 'machine:deleted', machine: { id: 'm-1' }, payload_version: 1 }).ok).toBe(true);
    expect(validateOutbound({ type: 'machine:deleted', id: 'm-1' }).ok).toBe(false);
  });
});

describe('validateOutbound — compattazione e bundle di dev', () => {
  test('stream:compaction — prima emissione (pre) e seconda (post)', () => {
    expect(validateOutbound({
      type: 'stream:compaction', sessionKey: 'sk-1', topicId: 'topic-1', markerId: 'mk-1',
      afterMessageId: 'm-9', trigger: 'auto', preTokens: 48900, createdAt: '2026-07-28T10:00:00Z',
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'stream:compaction', sessionKey: 'sk-1', markerId: 'mk-1', afterMessageId: null,
      trigger: 'manual', preTokens: 48900, postTokens: 1200, createdAt: '2026-07-28T10:00:00Z',
    }).ok).toBe(true);
  });

  test('stream:compaction rifiuta un trigger fuori vocabolario', () => {
    expect(validateOutbound({
      type: 'stream:compaction', sessionKey: 'sk-1', markerId: 'mk-1', afterMessageId: null,
      trigger: 'watchdog', createdAt: '2026-07-28T10:00:00Z',
    }).ok).toBe(false);
  });

  test('ui:bundle-updated e ui:bundle-rev', () => {
    expect(validateOutbound({ type: 'ui:bundle-updated', at: 1753700000000, rev: 'index-a1b2.js' }).ok).toBe(true);
    expect(validateOutbound({ type: 'ui:bundle-updated', at: 1753700000000 }).ok).toBe(true);
    expect(validateOutbound({ type: 'ui:bundle-rev', rev: 'index-a1b2.js' }).ok).toBe(true);
    expect(validateOutbound({ type: 'ui:bundle-rev' }).ok).toBe(false);
  });
});
