-- 085: le regole di consenso agli strumenti — «Consenti sempre», ma scritto
-- dove Topics comanda.
--
-- Fino a oggi l'unica cosa che teneva vivi gli strumenti MCP nelle chat era una
-- riga dentro `.claude/settings.local.json` del repo topics-app:
--
--     "mcp__topics__*"
--
-- un file GITIGNORATO, che nei worktree e altrove non c'è. Da lì il guasto per
-- cui questa tabella esiste: sotto `--permission-mode acceptEdits` (dove finiva
-- ogni chat, perché `auto-apply` è il default di 515 topic su 518) la CLI CHIEDE
-- il permesso per ogni tool MCP e per ogni scrittura fuori dalla cwd, Topics non
-- aveva un canale per rispondere, e la richiesta diventava un no muto:
--
--     Claude requested permissions to use mcp__gateway__kiwi__search-flight,
--     but you haven't granted it yet.
--
-- Misurato: lo stesso identico strumento passava se la chat girava nel repo e
-- moriva se girava in HOME. Una capacità non può dipendere da in quale cartella
-- è nata la chat.
--
-- `pattern` è la chiave primaria perché la regola È il pattern: concederlo due
-- volte non è un fatto nuovo, e la data della PRIMA concessione è quella che si
-- vuole leggere guardando la lista.
--
-- Nessun CHECK sul pattern, di proposito: le scritture passano da
-- `INSERT OR IGNORE` (idempotente sul doppio click), e un `INSERT OR IGNORE`
-- inghiotte anche le violazioni di CHECK — un pattern illegale sparirebbe in
-- silenzio invece di dare errore. La validazione (niente `*` nudo, solo nome
-- esatto o prefisso) vive in `server/lib/tool-grants.ts`, in un posto solo e
-- coperta dai test.
CREATE TABLE IF NOT EXISTS tool_grants (
  pattern TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  -- Da quale chat è stato concesso. PROVENIENZA, non politica: la regola vale
  -- per tutta l'app (è una decisione sullo strumento, non sulla conversazione),
  -- ma «da dove è uscito questo sì» è la domanda che si fa chi rilegge la lista
  -- sei mesi dopo. Nessuna FK: la chat può essere cancellata, la decisione resta.
  created_by_session TEXT
);
