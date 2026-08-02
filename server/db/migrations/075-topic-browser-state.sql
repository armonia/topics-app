-- 075-topic-browser-state.sql: dare a `Topic.browserState` una colonna.
--
-- Il campo esisteva nel tipo (`shared/types.ts`) e veniva SCRITTO — l'hook
-- `onNavigate` in server.ts fa `topic.browserState = { contextId, url, viewport }`
-- a ogni navigazione — ma non c'era nessuna colonna dove finire. E `rowToTopic`
-- ricostruisce un oggetto NUOVO a ogni lettura, quindi quella scrittura mutava
-- un oggetto di passaggio: la successiva `loadTopics()` restituiva un topic con
-- `browserState` di nuovo `undefined`. Una scrittura morta, invisibile perché il
-- valore sembrava esserci per il resto della richiesta.
--
-- Le conseguenze erano due, entrambe già in giro:
--   · `GET /api/topics` non ha MAI riportato `browserState` a nessun client;
--     `browser-persistence.spec.ts` copriva il buco con `if (…url) expect(…)`,
--     cioè un'asserzione che passava proprio quando il dato mancava.
--   · `restoreAllContexts` iterava i topic cercando `topic.browserState` e
--     saltava il 100% dei casi: «0 restored» su 962 boot. La riparazione (branch
--     jagged-parchment) è di leggere dal disco invece che da qui — resta giusta,
--     ma ora anche questo campo dice la verità.
--
-- Colonna TEXT con dentro il JSON del campo, come `mcp_policy` (migration 049).
-- NULL per ogni riga esistente: nessun topic ha mai avuto un valore leggibile,
-- quindi non c'è niente da riempire all'indietro.

ALTER TABLE topics ADD COLUMN browser_state TEXT;

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (75, '075-topic-browser-state', datetime('now'));
