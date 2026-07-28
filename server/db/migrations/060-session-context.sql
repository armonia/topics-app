-- 060-session-context.sql: l'ultima misura del contesto REALE per sessione.
--
-- `onContextSize` misura, a ogni chiamata al modello, quanto era grande il
-- prompt che il modello ha visto davvero. Finora quel numero moriva in RAM:
-- alla riapertura dell'app il ring sarebbe rimasto vuoto fino al turno
-- successivo, cioè proprio nel momento in cui l'umano si chiede "quanto è
-- piena questa chat?".
--
-- Una riga per sessione, sovrascritta: non è uno storico, è lo STATO. La
-- serie temporale, se un giorno servirà, sta nei marker di compaction.
-- FK CASCADE su topics(session_key) come `claude_code_sessions`: cancellata la
-- topic, la misura sparisce con lei invece di restare orfana per sempre.
CREATE TABLE IF NOT EXISTS session_context (
  session_key   TEXT PRIMARY KEY,
  used_tokens   INTEGER NOT NULL,
  window_tokens INTEGER NOT NULL,
  -- 1 = finestra dedotta dal default perché il modello non è in tabella.
  -- La UI lo mostra come "≈" invece di fingere una precisione che non ha.
  estimated     INTEGER NOT NULL DEFAULT 0,
  model         TEXT,
  measured_at   TEXT NOT NULL,
  FOREIGN KEY (session_key) REFERENCES topics(session_key) ON DELETE CASCADE
);
