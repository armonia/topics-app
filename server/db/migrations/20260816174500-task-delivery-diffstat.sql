-- QUANTO LAVORO C'È DENTRO UNA CONSEGNA, detto sulla card e non dietro un clic.
--
-- La colonna review chiede «Approva» e non dice cosa si approverebbe: niente
-- file, niente righe, niente esito. Il dato esisteva già — `worktreeDiffStat`
-- (branch-status.ts) misura file/+/- di UNA card partendo dal padre del suo
-- commit più vecchio, ed è testata — ma non la chiamava nessuno per la LISTA:
-- il diff si calcolava solo aprendo il drawer, cioè una card alla volta.
--
-- Perché una colonna e non un calcolo al volo: la lista della board è un feed
-- che si ridisegna a ogni push WebSocket, e tre comandi git per card a ogni
-- render trasformerebbero una board da 200 consegne in una tempesta di
-- processi. La misura si scrive quando la consegna avviene (e la riaggiorna
-- l'audit degli atterraggi, che quelle card le sta già visitando).
--
-- NULL = non misurato / non misurabile, che è diverso da zero: zero dice
-- «misurato, non ha prodotto niente» ed è una frase che va detta solo quando è
-- vera. `worktreeDiffStat` ha lo stesso contratto e restituisce `null` su HEAD
-- staccato o git in errore, apposta.
ALTER TABLE tasks ADD COLUMN delivery_files_changed INTEGER;
ALTER TABLE tasks ADD COLUMN delivery_insertions INTEGER;
ALTER TABLE tasks ADD COLUMN delivery_deletions INTEGER;
