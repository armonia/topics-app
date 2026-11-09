# C2 — `:3360` e `:3335` rimandano a Topics

**Cosa:** le pagine di `:3360` e `:3335` rispondono 302 verso la vista giusta di Topics (`/#automations`, `/#journal`, `/#accounts` diventano i posti di `hub-smistamento`); le API restano risposte dal servizio come alias. L'interfaccia dell'hub va nel tag `hub-ui-final` (non si perde). I link fissi (`hubSystem.ts` `http://127.0.0.1:3360/#journal`, tray, brief del mattino, TOOLS.md e AGENTS.md) puntano a Topics.
**Dipendenze:** C1.
**Barra:** `curl -sI :3360/` e `:3335/` rispondono 302; i bookmark `#automations`, `#journal`, `#accounts` arrivano al posto giusto (scenario «Bookmark vecchi» con video); `/api/*` identiche (`golden-diff`).
**Fuori:** chiudere le porte (Z1).
**Stima:** 1,5 h.
