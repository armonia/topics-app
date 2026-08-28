-- 20260828094444-tetti-di-spesa-spenti.sql
--
-- Il prefisso è un timestamp UTC (YYYYMMDDHHMMSS), non un contatore: è quello
-- che rende impossibile la collisione fra card in parallelo. Non rinominarlo.
--
-- I DUE TETTI DI SPESA, E NASCONO SPENTI. Zero vuol dire ILLIMITATO, ed è il
-- valore con cui parte ogni installazione: il freno esiste come leva, non come
-- comportamento. Nessun default acceso, nessun valore precompilato da
-- accettare per inerzia; li imposta una persona dalle impostazioni.
--
-- Perché DUE e non uno: colgono guasti diversi. Il tetto per card prende la
-- card che scappa da sola (la più cara misurata: 99,70 USD); quello per
-- macchina su 24 ore prende la notte che scappa (giorno peggiore: 2.569 USD, su
-- molte card ciascuna sotto il proprio tetto). Nessuno dei due vede il guasto
-- dell'altro.
--
-- Stanno su `board_settings` perché è la tabella che ospita già il tetto degli
-- agenti in parallelo, e come quello vivono sulla RIGA RISERVATA '*': il freno è
-- della macchina, non di una board. N board con un tetto ciascuna sarebbero
-- N tetti moltiplicati, cioè nessun tetto.
ALTER TABLE board_settings ADD COLUMN agent_cost_cap_cents INTEGER NOT NULL DEFAULT 0;

ALTER TABLE board_settings ADD COLUMN agent_cost_cap_cents_24h INTEGER NOT NULL DEFAULT 0;
