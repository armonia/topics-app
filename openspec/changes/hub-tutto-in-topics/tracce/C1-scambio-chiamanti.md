# C1 — Scambio dei chiamanti (dopo il sì del pacchetto)

**Cosa:** i chiamanti parlano al servizio nuovo. `:3336` è già la porta delle sessioni: `ANTHROPIC_BASE_URL` in `~/.claude/settings.json` e `~/.zshrc` riga 69 non cambia; il vecchio switchboard si ferma e il servizio prende `:3336`. Gli hook `session-start`/`session-stop` (`settings.json` righe 121 e 150, con `|| true`), `~/.jcode/config.toml:322`, `setup/jcode/jcode-vdm-gate.sh`, `punto`, `mailwatch.py`, `riprendi-sessioni-limite.sh`, `cloud-lancia`, `brief-mattutino.sh`, `claude-account`, `usage-watch.mjs`, `quota-reserve-hook`, i 12 script «Ti aspetta» e il ponte `server/routes/hub.ts` passano ai nomi del servizio; `server.mjs` riga 495 perde l'alias `:3337`; `~/.agents/hooks/usage-budget` smette di puntare a `claude-usage-hub`.
**Come, senza rompere:** periodo doppio con alias, vecchio fermo ma pronto (`rollback`); si scambia un gruppo alla volta e `alias-check` dopo ciascuno.
**Dipendenze:** R2, R3, R4 verdi sulle fotografie; il sì del pacchetto.
**Barra:** `alias-check` esce 0; `golden-diff` contro la copia di ritorno verde; scenario «riavvio senza buchi» con video; nessuna sessione perde un turno durante lo scambio (registro del proxy).
**Fuori:** spegnere i vecchi processi (Z1).
**Stima:** 3 h.
