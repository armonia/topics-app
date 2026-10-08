# V3 — verifica indipendente dell'integrazione

**GOAL.** Smentire. Trova i difetti che le verifiche traccia per traccia non vedono: quelli nati
dalla somma delle tracce, le regressioni, i numeri che non reggono. Non scrivi fix: un difetto
si consegna con la sua prova (comando, output, test rosso), e lo corregge un'altra sessione.

- **Base:** `main` @ `396451881`. **Testa:** `origin/cloud/quality-pass-integrata` (oggi T1, T2,
  T3 server, T5, T6, T7, T9; mentre lavori possono entrare T8, T2b, T10b, T7b).
- I REPORT delle tracce sono in `openspec/changes/cloud-quality-pass/reports/`; il giudizio del
  coordinatore traccia per traccia è nella PR #251 e nei commenti delle PR #246-#255.

## B1 · verde resta verde (base contro testa, stessa VM)

`qa-gate.sh --veloce`, `test:unit:shards`, `build:client` + `check:bundle`, e2e di area in Chromium
(`topic-*`, `chat-*`, `board-*`, `task-*`, `*cls*`, `refresh-cls`, `pane-return-cls`). Ogni test verde
su base e rosso sulla testa è un difetto finché non provi il contrario (rilancio da solo, tre volte).
Unit del server anche su **Bun 1.3.8** (`_comuni.md`, Setup 2): un rosso solo lì è un difetto.

## B2 · un numero per traccia, rimisurato (base contro testa alternati, almeno 3 coppie)

Il comando è quello del REPORT della traccia. T1: `check:ink` tab e primo frame della topic visitata ·
T2: `check:ink` card e render per mossa · T3: avvio del server di test · T5: `check:route-latency`
sulle due rotte · T6: durata di `qa-gate.sh --veloce` · T7: CLS delle tre scene con immagine · T9:
`GET /api/git/branches` e ritardo del loop. Per ognuno: CONFERMATO / SMENTITO / NON MISURABILE QUI,
con i numeri e il carico (`uptime`).

## B3 · i punti dove due tracce si toccano

1. Chat: il pin a riposo di T7 (`MessageList`, microtask), il sipario e la rivelazione di T1, il pin
   dello streaming. Una chat in fondo che riceve righe, una che sta leggendo più su (non deve
   saltare in fondo), un cambio di topic durante l'arrivo di una riga.
2. Processi: `bounded-spawn` di T5 e la vivezza dei pid di T9 nello stesso `processes.ts` (Stop,
   sweep delle shell, server che si spegne con figli vivi).
3. Board: lo store di T2 (`useGlobalBoard`) con gli aggiornamenti dal vivo dei task; se entra T10b,
   con il feed dimagrito (i 19 campi omessi: nessuno li legge davvero?).
4. Avvio: gli import pigri di T3 con i cancelli paralleli di T6 e con i test che li caricano.
5. Ospiti: i frame `message:new`/`message:media` con `mediaSizes` (T7) arrivano anche a un socket
   ospite? Dicono qualcosa che l'ospite non potrebbe già leggere?

Per ogni punto: lo scenario provato (test o script), cosa è successo, verdetto.

## Consegna

Ramo `cloud/v3-verifica-integrata` con `openspec/changes/cloud-quality-pass/reports/V3.md`: in testa
la tabella B2 e l'elenco dei difetti (gravità, riproduzione in un comando, file:riga); poi B1 e B3.
Test che dimostrano un difetto: aggiungili sul ramo, rossi, e dillo. «Nessun difetto» vale solo con
le prove di ogni punto. Prima di consegnare: `git fetch`; se l'integrazione ha teste nuove, rifai B1
e il numero delle tracce entrate sull'ultima testa.

**FUORI.** Fix del codice di produzione, migrazioni, nuove ottimizzazioni.
