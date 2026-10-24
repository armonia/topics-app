-- 20261024120001-browser-store-reap.sql
--
-- Il prefisso è un timestamp UTC (YYYYMMDDHHMMSS), non un contatore: è quello
-- che rende impossibile la collisione fra card in parallelo. Non rinominarlo.
--
-- The cleanup of closed browsers' data becomes a setting of Topics.
--
-- `client/src/lib/browserDataStoreReaper.ts` removes the WKWebView stores of
-- browsers that no row of `ui_state` names any more and that nobody has used
-- for a while. The removal cannot be undone (cookies, logins and every site's
-- local data go with the store), so it runs only on a setting the person can
-- see and turn off (Attilio, approving #425).
--
-- TWO NULLABLE COLUMNS, NOTHING REWRITTEN. This runs on the live database when
-- the app updates: the singleton row keeps every value it had and gains two
-- NULLs, and NULL is the meaning of "never touched", resolved in
-- `shared/browser-store-reap.ts`: ON, after 60 days without use. The days are
-- clamped to 7..365 by the route that writes them and again by the reaper.
ALTER TABLE app_settings ADD COLUMN browser_store_reap_enabled INTEGER;
ALTER TABLE app_settings ADD COLUMN browser_store_reap_after_days INTEGER;
