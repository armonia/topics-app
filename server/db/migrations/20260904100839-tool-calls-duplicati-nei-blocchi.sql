-- La colonna `tool_calls` sparisce dalle righe che hanno gia' i `blocks`.
--
-- Le due colonne portano la stessa cosa. Il filo lo sa da un pezzo
-- (`leanMessageForWire`, shared/lean-tool-call.ts: «they carry the same thing
-- and the renderer uses the blocks»), il disco no. Misurato sul database di
-- questa macchina: `tool_calls` pesa 149,2 MB, di cui 144,4 MB su righe che
-- hanno ANCHE `blocks`, e sulle 40 righe piu' pesanti ogni toolCall della
-- colonna esiste identico dentro i blocchi. E' il grosso dei 350 MB della
-- tabella `messages`, cioe' la ragione per cui ogni scansione costa quasi un
-- secondo, e lo pagano anche i backup, il WAL e la page cache.
--
-- Da dove tornano fuori: `rowToMessage` (server/utils.ts) ricostruisce
-- `msg.toolCalls` dai blocchi di tipo `tool` quando la colonna e' vuota. Un
-- punto solo, quindi lo vedono tutti i lettori: `loadActiveThread`,
-- `/api/history`, `getMessageById` e Rigenera, che legge `msg.toolCalls` come
-- evidenza del turno che sta sostituendo (server/routes/edit.ts).
--
-- Le righe SENZA blocchi non si toccano: li' la colonna e' l'unica fonte che
-- c'e' (4,8 MB su 5.332 righe sullo stesso database), e perderla vorrebbe dire
-- perdere i tool call di quei messaggi.
--
-- `blocks` puo' essere un BLOB zstd (shared/message-blob.ts): il confronto
-- guarda solo i tre valori VUOTI, che stanno sotto la soglia di compressione e
-- restano quindi testo in chiaro. Un BLOB non e' uguale a nessuno dei tre e
-- conta come pieno, che e' la lettura giusta.
--
-- Niente VACUUM: su un database da centinaia di MB e' minuti di lock dentro
-- una migration, cioe' l'app che non parte. Le pagine liberate le riusa SQLite
-- da sola; le righe, che e' quello che conta per le scansioni, diventano
-- piccole subito.

UPDATE messages
   SET tool_calls = NULL
 WHERE tool_calls IS NOT NULL
   AND tool_calls NOT IN ('', '[]', 'null')
   AND blocks IS NOT NULL
   AND blocks NOT IN ('', '[]', 'null');
