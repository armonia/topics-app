-- 20261121111141-readable-view-cache.sql
--
-- Il prefisso è un timestamp UTC (YYYYMMDDHHMMSS), non un contatore: è quello
-- che rende impossibile la collisione fra card in parallelo. Non rinominarlo.
--
-- Scrivi qui SOTTO cosa cambia e perché. Poi:
--   bun run scripts/gen-migrations-manifest.ts   (se hai toccato il nome)
--   bun run check:migrations

-- Cache of the model's declarative spec for a tool-result SHAPE never seen
-- deterministically: readable-view.ts hashes keys+types (never values) into
-- `signature`, so the same shape on different data calls the model once.
-- `spec_json` is NULL for a shape the model failed to produce a valid spec
-- for, so a doomed shape is not retried on every render.
CREATE TABLE IF NOT EXISTS readable_view_cache (
  signature TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  spec_json TEXT,
  created_at TEXT NOT NULL
);
