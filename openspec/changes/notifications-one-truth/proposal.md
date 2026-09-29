## Da decidere

Nessuna scelta aperta: decise da Jarvis su delega, dopo la segnalazione di Attilio del 29/09.

1. Un solo «visto» per soggetto (chat, terminale): aprire la chat, cliccare la sua notifica nel pannello o aprire il pannello (che è il «segna tutto») spengono la stessa cosa ovunque, non-letti della chat compresi.
2. Il «segna tutto» spegne anche le chat con non-letti e nessuna riga non vista (le 6 chat ferme di oggi) e i segni «finito» dei terminali; risparmia solo ciò che ha una notifica arrivata dopo che la lista è stata letta.
3. Il numero globale (Dock, tray, badge PWA) e quello della campanella contano SOGGETTI, non messaggi: una chat con 39 non letti vale 1. Riga e tab continuano a mostrare quanti messaggi.
4. Il rollup del progetto (badge della riga di progetto) resta una somma di messaggi: è un badge di riga, e la decisione 3 riguarda solo i numeri globali.
5. Nessuna migration: bastano le tabelle `unread` e `notification_log` che ci sono.

| # | Dove cambiarla |
|---|----------------|
| 1, 2 | `NOTIF-ONE-01` (`server/subject-seen.ts`) |
| 3 | `NOTIF-ONE-02`, `CHROME-COUNT-01` (`rollupGlobalAttention`, `countUnseenNotifications`) |
| 4 | `rollupProjectAttention` in `client/src/state/signals.ts` |

---

# Le notifiche sono una verità sola

## Why

Attilio, 29/09: «vedo 133 notifiche, aprendo le notifiche della sidebar se ne
vanno ma restano ovunque». Misurato sul DB vivo: 0 righe non viste in
`notification_log`, 132 messaggi non letti su 6 chat nella tabella `unread`.

Due difetti:

- il numero del Dock (`chromeAttentionTotal`) sommava i MESSAGGI, mentre il
  pannello elenca i SOGGETTI;
- il «visto» del pannello (`POST /api/notifications/seen`) segnava solo le righe
  del registro; aprire la chat azzerava `unread` e le righe. I due archivi
  divergevano in un verso solo, e il pannello diceva «niente» mentre tutto il
  resto restava acceso.

## What Changes

- Una porta sola lato server, `server/subject-seen.ts`: `markTopicSeen`
  (aprire la chat), `markNotificationRowsSeen` (righe cliccate),
  `markAllNotificationsSeen` (aprire il pannello). Tutte azzerano `unread` e le
  righe, e lo annunciano con i frame che ogni finestra ascolta già
  (`unread:updated`, `notification:seen`).
- `POST /api/topics/:id/read` e `POST /api/notifications/seen` passano da lì;
  il «visto per bersaglio» di un topic pure.
- `notification:seen` porta `subjects` o `allExcept`: ogni finestra spegne i
  propri segni in memoria (terminale «finito», chat «done») e i pallini delle sole
  righe nominate.
- `rollupGlobalAttention` e `paneAttentionTotal` contano soggetti;
  `countUnseenNotifications` conta gruppi distinti.

## Impact

`server/subject-seen.ts`, `server/db/notification-log.ts`,
`server/notification-registry.ts`, `server/routes/notifications.ts`,
`server/routes/topics.ts`, `server/utils.ts`, `shared/ws-outbound.ts`,
`client/src/state/signals.ts`, `client/src/state/attentionTotal.ts`,
`client/src/state/useSignalsSync.ts`, `client/src/hooks/useNotificationHistory.ts`,
`client/src/lib/notify/seenFrame.ts`, `client/src/types/index.ts`.
Prova: `tests/e2e/notifications-one-truth.spec.ts`, `server/subject-seen.test.ts`,
`client/src/lib/notify/seenFrame.test.ts`, `client/src/state/attentionTotal.test.ts`.
Nessuna migration.
