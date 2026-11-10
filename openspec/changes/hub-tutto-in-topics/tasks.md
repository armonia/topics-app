# Tasks — hub-tutto-in-topics

Una traccia = una card sulla board `topics-app-ar3jt5`. Il file della traccia è in `tracce/`. Lo stato lo dà git/il test, non la casella. Regola per tutte: in review solo per screenshot affiancato di UI nuova (`vis affianca`); il resto si chiude con la prova (`board-card --chiudi`). Nessuna traccia tocca launchd o `settings.json` vivi prima del sì del pacchetto (C1, C2, Z1).

| Traccia | File | Dipende da | Stima (a occhio) |
|---|---|---|---|
| S1 Campanella | `tracce/S1-campanella.md` | — | 2 h |
| S2 Account, quote, consumi, freno | `tracce/S2-account-quote.md` | — | 3 h |
| S3 Processi, Mac e PC, backup | `tracce/S3-processi-macchine.md` | — (chiusura vera: R3) | 3 h |
| S4 Lavori, Progetti, Automazioni, Contesto, Funzionalità | `tracce/S4-lavori-progetti-automazioni.md` | — | 3 h |
| R1 Servizio: scheletro e fotografie | `tracce/R1-servizio-fotografie.md` | — | 2 h |
| R2 Sempre acceso: ritmo, rotta, Ti aspetta, gate | `tracce/R2-sempre-acceso-hub.md` | R1 | 3 h |
| R3 Letture per tray e ponte | `tracce/R3-letture-tray-ponte.md` | R1 | 4 h |
| R4 Proxy e account | `tracce/R4-proxy-account.md` | R1 | 6 h |
| C1 Scambio dei chiamanti | `tracce/C1-scambio-chiamanti.md` | R2, R3, R4 + sì | 3 h |
| C2 `:3360` e `:3335` rimandano | `tracce/C2-3360-rimanda.md` | C1 | 1,5 h |
| Y1 Tray: dati e barra | `tracce/Y1-tray-dati-barra.md` | — | 4 h |
| Y2 Tray: menu e azioni | `tracce/Y2-tray-menu-azioni.md` | Y1, R3 | 5 h |
| Z1 Spegnimento e ritorno indietro | `tracce/Z1-spegnimento.md` | C2, Y2 + sì | 2 h |

Totale a occhio: 41,5 h di lavoro agente. Il registro `stime` dice che a occhio si sfora quasi ×3: le tracce S, R1-R3 e Y1 partono insieme (nessuna dipende da un'altra), e il cammino lungo è R1 → R4 → C1 → C2 → Z1.

## Ordine
1. In parallelo: S1-S4, R1, Y1.
2. Dopo R1: R2, R3, R4 in parallelo; dopo Y1: Y2.
3. Quando R2, R3, R4 sono verdi sulle fotografie: il sì del pacchetto, poi C1 → C2 → Z1.

## Collegamenti con altre card e rami
- Card 1efebacc «Un solo "Ti aspetta"»: si lega a S1.
- Card b3e19133 «Lag all'apertura della tray»: si lega a Y1.
- Ramo `proxy/sessioni-esterne` (listener `:3350`): R4 e C1 si rebasano dopo che è entrato.
