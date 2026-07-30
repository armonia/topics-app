-- 072: toglie pin e menzioni che puntano a messaggi che non esistono piu'.
--
-- Ne' `topic_pinned_messages.message_id` ne' `mentions.message_id` hanno una FK
-- verso `messages`: fino al 30/07 cancellare un messaggio (o un intero
-- sottoalbero) lasciava indietro le righe che lo citavano. Nel DB vivo se ne
-- contavano 2, entrambe pin nate dopo il 15/07 — non sono figlie della bonifica
-- 071, che i pin dei turni che cancella li porta via da se'.
--
-- Il buco strutturale e' chiuso a monte: `deleteMessageSubtree` (server/utils.ts)
-- ora ripulisce pin e menzioni e fa ereditare al marcatore di compattazione il
-- padre del sottoalbero. Questa migration bonifica quello che era gia' rimasto.
--
-- I marcatori di compattazione NON si toccano qui: uno appeso indica il punto
-- del thread dove sta la compattazione, e senza il padre a cui rimandarlo
-- azzerarlo lo sposterebbe in testa — sul DB vivo comunque sono zero.

DELETE FROM topic_pinned_messages
 WHERE message_id NOT IN (SELECT id FROM messages);

DELETE FROM mentions
 WHERE message_id NOT IN (SELECT id FROM messages);
