-- 20261024120001-browser-store-reap.sql
--
-- Il prefisso è un timestamp UTC (YYYYMMDDHHMMSS), non un contatore: è quello
-- che rende impossibile la collisione fra card in parallelo. Non rinominarlo.
--
-- The cleanup of closed browsers' data becomes a setting of Topics, at two
-- levels.
--
-- `client/src/lib/browserDataStoreReaper.ts` cleans up the WKWebView stores of
-- browsers that no row of `ui_state` names any more and that nobody has used
-- for a while. Level 1 empties only their cache and keeps the logins; level 2
-- removes the whole store, and that cannot be undone (cookies, logins and every
-- site's local data go with it). Attilio, on #425: cookies and history are what
-- keep a login alive, so the whole-store removal is off unless somebody says so.
--
-- THREE NULLABLE COLUMNS, NOTHING REWRITTEN. This runs on the live database when
-- the app updates: the singleton row keeps every value it had and gains three
-- NULLs, and NULL is the meaning of "never touched", resolved in
-- `shared/browser-store-reap.ts`:
--   browser_store_cache_reap_enabled  level 1, NULL = ON (cache only)
--   browser_store_reap_enabled        level 2, NULL = OFF (whole store)
--   browser_store_reap_after_days     shared, NULL = 60 days
-- The days are clamped to 7..365 by the route that writes them and again by
-- the reaper.
ALTER TABLE app_settings ADD COLUMN browser_store_cache_reap_enabled INTEGER;
ALTER TABLE app_settings ADD COLUMN browser_store_reap_enabled INTEGER;
ALTER TABLE app_settings ADD COLUMN browser_store_reap_after_days INTEGER;
