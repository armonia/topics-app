-- 20261006000001-app-settings-muse-model.sql
--
-- Il prefisso è un timestamp UTC (YYYYMMDDHHMMSS), non un contatore: è quello
-- che rende impossibile la collisione fra card in parallelo. Non rinominarlo.
--
-- The Muse provider's configured default model (`AppSettings.museModel`),
-- the muse analogue of `codex_model` (054). NULL = never touched = the CLI's
-- own default from `~/.config/muse/settings.json`.

ALTER TABLE app_settings ADD COLUMN muse_model TEXT;
