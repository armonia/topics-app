-- "None" as a person's explicit choice (limiti-consumo-progetto): until now a
-- NULL limit meant both "never configured" and "chosen None". The column
-- tells them apart. Additive only: project_quota is live since 20261119000000.
ALTER TABLE project_quota ADD COLUMN limit_none INTEGER NOT NULL DEFAULT 0;
