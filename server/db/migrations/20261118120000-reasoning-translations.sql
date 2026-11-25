-- The reasoning ("Thinking") text translated into the chat language, one row per
-- sentence and target language, so a reload shows the translation without
-- translating again. Keyed by the hash of the sentence itself, not by a message:
-- the same sentence in two chats costs one translation, and the cache never has
-- to follow a message that is renamed or branched.
CREATE TABLE IF NOT EXISTS reasoning_translations (
  source_hash     TEXT NOT NULL,
  target_language TEXT NOT NULL,
  source_language TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (source_hash, target_language)
);
