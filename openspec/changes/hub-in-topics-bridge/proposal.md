# Hub in Topics: il ponte (traccia 0)

## Perché
L'interfaccia dell'hub (:3360) e di switchboard (:3335) entra in Topics (piano: `~/.claude/jarvis/docs/hub-in-topics.md`). Prima dei pannelli serve una porta: Topics deve poter leggere e scrivere sulle loro API senza copiarle, e i dati che cambiano (quote, Mac, servizi) devono arrivare in diretta invece che col polling a 60 s delle pagine dell'hub.

## Cosa cambia
- `server/routes/hub.ts`: `/api/hub/*` → `:3360/api/*`, `/api/switchboard/*` → `:3335/api/*`; percorsi che potrebbero cambiare destinazione rifiutati (400), hub giù = 502/504 col motivo, niente Origin/Cookie/Authorization a monte; in e2e nessun default (503).
- `server/lib/hub-live.ts`: un solo lettore, solo con almeno una finestra connessa, ogni 15 s; frame `hub:live` per argomento solo se cambia; `GET /api/hub-live` per il primo disegno.
- `client/src/state/hubLive.ts`: lo store che i pannelli delle tracce 2-3 useranno.

## Barra
`bun test server/routes/hub.test.ts server/lib/hub-live.test.ts tests/unit/ws-outbound-schema.test.ts tests/unit/ws-outbound-coverage.test.ts server/route-table.test.ts` e `cd client && bun test src/state/hubLive.test.ts` escono 0; `check:route-shadowing`, `check:spec-coverage`, `check:comment-language`, `typecheck` escono 0. Spec: `openspec/specs/hub-bridge/spec.md` (HUBBR-01..03).

## Fuori
I pannelli (tracce 2-8), il porting Rust (traccia R, nel repo jarvis), qualsiasi modifica all'hub.

## Non ancora specificato
- Le voci di `/api/attesa` nell'Inbox: tipo nuovo di attenzione o system notice. Si decide con la variante scelta.
