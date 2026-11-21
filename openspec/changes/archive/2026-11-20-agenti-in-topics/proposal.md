# Agenti in Topics: configurazione di Jarvis e Visione

## Da decidere
Niente: nessuna spesa, nessun dato nuovo che esce, le scritture hanno il backup.

## Perché
La configurazione di Jarvis e Visione (jarvis-channels) sta in cinque posti: `config.json` (canali, account, 53 regole di chat, modelli per canale, instradamento a Visione), `engine.json` (modello e workspace), `jobs.json` (136 lavori), `IDENTITY.md`/`SOUL.md` nei due workspace. Si cambia solo a mano, e i doppioni divergono.

## Mappa (letta il 09/11)
- Canali e account: `config.json › channels` (Discord `default`=Jarvis, `visione`=Visione; Telegram e WhatsApp solo Jarvis). Letto da jarvis-channels all'avvio.
- Regole per chat e chi può scrivere: `config.json › rules.groups` (attiva, menzione, `senders`, `denied`, istruzioni `system`), `rules.owners`, `rules.dm`. Letto all'avvio.
- Instradamento a Visione: `rules.agents` (chat → `gtm`). Modello: `engine.json › model` e `rules.models` per canale/chat.
- Lavori: `jobs.json` (riletto a caldo per mtime). Personalità: `IDENTITY.md`, `SOUL.md` dei workspace (letti a ogni turno).
- Incoerenze trovate: 12 chat Discord scritte due volte (regola Jarvis e regola Visione) con menzione diversa; `rules.models.discord["*"]` = opus contro `engine.json` sonnet; numero di Attilio scritto in 4 forme in `rules.models.whatsapp`; 39 lavori `agent` senza agente esplicito.

## Stato dell'arte
Letta, OpenHands, n8n e Botpress tengono un'anagrafica per agente con persona, modello, canali e strumenti in schede, e validano prima di salvare: lo stesso schema qui, sui file veri.

## Cosa cambia
- `server/routes/agent-config.ts`: `GET /api/agent-config` (anagrafica, incoerenze, `jarvis-channels health`), `POST …/chat|job|persona`: valida, copia in `jarvis-channels/backups/`, scrittura atomica; per `config.json` riavvia il servizio solo a zero turni in corso (`inflight.json`), altrimenti lo dice.
- `client/src/components/Agents/AgentProfiles.tsx` in testa alla vista Agenti: schede Jarvis/Visione, salute, da sistemare, personalità modificabile, modello e account, chat con interruttori (risponde, solo se citato), lavori con interruttore. Interruttori sul modello «Weekly hours» di Bruno Delorence.

## Barra
`bun test server/routes/agent-config.test.ts` e `pw-remote -- npx playwright test tests/e2e/agents-config.spec.ts` escono 0; con `account` tolto dal post della chat lo scenario è rosso.

## Fuori
`turn.rs` e l'affidabilità di jarvis-channels; modifica delle istruzioni `system` per chat, dei `senders` e della pianificazione dei lavori (lettura sì, scrittura dopo); correzione automatica delle incoerenze (si mostrano, non si toccano).

## Non ancora specificato
Se le regole doppie di Visione vadano fuse in una regola con due account: dipende da come jarvis-channels sceglierà l'account, non lo so formulare ora.
