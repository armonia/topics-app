-- The calendar the sidebar reads: WHERE it comes from, and how often.
--
-- Card aa641133: pinning the Google Calendar tab has to give the agenda too,
-- the way Arc and Dia do, and the sync has to be configurable from Settings.
--
-- WHY A FEED URL AND NOT A GOOGLE LOGIN. Reading a Google account through the
-- API means an OAuth client, and an OAuth client means a client id (and, for
-- every flow Google offers a desktop app, a client secret) shipped inside an
-- MIT repository anyone can read, plus a verification review before the consent
-- screen stops calling this app unsafe. The same events are already published
-- by Google itself as an iCalendar feed -- Settings > Calendar settings >
-- "Secret address in iCal format" -- and that address works identically for
-- Apple, Outlook, Proton and Fastmail. One column instead of a credential
-- store, and the integration is not tied to a single vendor.
--
-- THE URL IS A SECRET AND STAYS ON THIS MACHINE. Whoever holds it reads that
-- calendar without any further authentication, so it lives in the local
-- database like `profile_share_token` does, it is never logged, and the agenda
-- endpoint never echoes it back.
--
-- NULL = never touched = OFF, on all four columns. Before anyone opens
-- Settings, nothing is fetched and no request leaves the machine: an
-- integration that starts reading a calendar because the app was installed is
-- not a default, it is a surprise.
--
-- `calendar_refresh_minutes` is the MAXIMUM AGE of the cached agenda, not a
-- timer: the sync is pull-based (see server/services/calendar-feed.ts), so an
-- app nobody is looking at makes no requests at all.
ALTER TABLE app_settings ADD COLUMN calendar_enabled INTEGER;
ALTER TABLE app_settings ADD COLUMN calendar_feed_url TEXT;
ALTER TABLE app_settings ADD COLUMN calendar_refresh_minutes INTEGER;
ALTER TABLE app_settings ADD COLUMN calendar_horizon_days INTEGER;
