## Why

L'audit del chat-topic (2026-07-10) contro i benchmark open-source (lobe-chat,
open-webui, LibreChat) ha lasciato quattro gap "table stakes" sul pacchetto
conversazione: regenerate SOLO come error-recovery su prefisso ⚠️ (string-sniff,
ChatPane), nessuna cancellazione messaggi, nessun export, e la ricerca messaggi
⌘K che NON trova i contenuti delle chat correnti (searchTranscripts scansionava
solo i transcript JSONL legacy del gateway — la metà SQLite del "hybrid" non era
mai stata implementata).

## What Changes

1. **Regenerate generale (CHAT-CONV-01).** `POST /api/messages/:id/regenerate`
   forka un branch assistant FRATELLO sotto lo stesso messaggio utente e
   ri-streama, riusando l'intera pipeline SSE di /edit; il prompt è troncato
   all'anchor così il modello non vede la risposta che sta sostituendo. La
   risposta precedente resta raggiungibile con le frecce di branch. Fix
   strutturale abilitante: `createBranchPartialMessage` alloca il PROSSIMO
   branch index e lo attiva (era hardcoded 0 — corretto per edit, collidente
   per regenerate). Client: bottone RotateCw sulla toolbar dei messaggi
   assistant, disattivato durante lo streaming; `useChat` rifattorizzato con
   runner SSE condiviso (`runBranchStream`) per edit+regenerate.
2. **Delete messaggio (CHAT-CONV-02).** `DELETE /api/messages/:id` cancella il
   messaggio e TUTTO il sottoalbero discendente (CTE ricorsiva), rinumera i
   fratelli superstiti densi (le frecce fanno ±1 su branch_index letterali),
   ripara/clampa il puntatore active_branches e ritorna il thread attivo
   riparato (stesso contratto di switch-branch). Client: bottone Trash2 con
   conferma two-click (arma 3s, poi fuoco) nella toolbar.
3. **Export conversazione (CHAT-CONV-03).** Voce "Export conversation" nel menu
   ⋯ del composer: scarica il THREAD ATTIVO come Markdown (client-side — è
   esattamente la vista che l'utente sta guardando), filename dal nome topic.
4. **Fix ricerca messaggi (CHAT-CONV-04).** `searchTranscripts` ora interroga
   PRIMA la tabella SQLite `messages` (LIKE case-insensitive, wildcard utente
   escapate, topic risolto via session_key) e poi i JSONL legacy.

**Non-goal:** share-link pubblici (nessuna infra di hosting); regenerate con
provider/model diverso al volo (il picker già governa il provider di sessione);
export di TUTTI i branch (si esporta il thread attivo).
