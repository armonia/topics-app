# Z1 — Spegnimento dei vecchi processi, con ritorno indietro

**Cosa:** a barra verde si fermano `com.jarvis.usage-hub` (:3360), `com.jarvis.switchboard` (:3335/:3336) e `com.jarvis.claude-usage-tray`; i plist vanno in `~/Library/LaunchAgents/disabled/`; il sorgente della tray Swift e l'hub restano nel repo e nel tag `hub-ui-final`. Un cron chiude gli alias `:3360` e `:3335` dopo 24 ore senza chiamanti diversi dal 302. TOOLS.md e AGENTS.md (citano `:3360`) e il piano `docs/hub-in-topics.md` si aggiornano; `agents-doctor` resta verde.
**Dipendenze:** C2 e Y2; il sì del pacchetto.
**Barra:** `launchctl print` dei tre vecchi esce non-zero; `lsof` mostra una porta sola; `rollback` provato prima e dopo (meno di 60 secondi, `golden-diff` verde); cron di chiusura alias creato (id nel resoconto).
**Fuori:** cancellare il codice vecchio.
**Stima:** 2 h.
