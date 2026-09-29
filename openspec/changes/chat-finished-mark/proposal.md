## Da decidere

Nessuna scelta: parità coi terminali chiesta da Attilio il 29/09.
Compreso, senza scelta: il segno vale per ogni runtime (hook o no); si spegne aprendo la chat o al turno dopo; come quello dei terminali vive in memoria e un ricarico lo azzera; un banner per turno anche con due finestre.

| # | Dove cambiarla |
|---|----------------|
| — | `CHAT-DONE-01` (il segno), `CHAT-DONE-02` (il banner) |

---

# Una chat che ha finito si vede, come un terminale che ha finito

## Why

Un terminale che finisce il turno accende un segno che resta finché non lo apri
(`terminal:activity { finished: true }` → `terminalFinishedIds`). Una chat no:

- senza hook Claude Code (provider `topics`, routing Topics, codex, jcode, ACP)
  riceveva solo il conteggio dei non letti, nascosto sulla tab attiva e segnato
  letto all'arrivo se la finestra è «sveglia»;
- con gli hook il fondo blu `awaiting-user` spariva dopo ~15 minuti, quando la
  fase diventa `completed`.

Il banner di fine turno (6df29a334) suonava, ma dentro l'app non restava niente.

## What Changes

- `chatFinishedTopics` nello store dei segnali, gemello di `terminalFinishedIds`:
  si accende su `stream:end` pulito (`shared/chat-turn-end.ts`), si spegne su
  `stream:start` o quando la chat è davanti (`useClearChatFinishedWhileViewed`).
- Entra in `awaitingFeedbackTopics`: riga, tab, progetto e gruppi lo dipingono col
  tier `done` («turno finito») che usano già, senza widget nuovi.
- La riga della sidebar espone `data-attention` come la tab.
- Il banner di `stream:end` claima la stessa chiave di `message:new` (il
  `messageId` della risposta): due finestre, un banner.

## Impact

`client/src/state/signals.ts`, `useSignalsSync.ts`, `lib/notify/chatFinished.ts`,
`hooks/useCompletionNotifier.tsx`, `components/Chat/ChatPane.tsx`,
`components/Sidebar/TopicItem.tsx`. Prova: `tests/e2e/chat-finished-banner.spec.ts`,
`client/src/lib/notify/chatFinished.test.ts`.
