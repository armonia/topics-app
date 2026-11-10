# Y2 — Tray di Topics: menu, schede e azioni

**Cosa:** il menu al clic della tray vecchia in quello di Topics: una scheda per Mac e PC (grafici, i processi che pesano), pannello quote con ritmo, un provider che non risponde, progetti con sottomenu (lavori, chat Topics, consumi, budget e priorità), «Altri abbonamenti e opzioni» (freno, rinnovi, credito AI e i tre interruttori fascia 5 ore, credito API, bonus cloud, che restano preferenze), Automazioni, In calendario, Backup del Mac (letto da `state/backup-mac.json` anche con il servizio giù), Apri Topics, Aggiorna, Esci. Azioni: freno (`/api/override`, `/api/hold`, `/api/heavy`), `/api/project-settings`, finestra Processi (cerca, ordina, chiudi sicuro), apri una sessione dove si trova. Le voci che aprivano `:3360` aprono i posti di Topics.
**Dipendenze:** Y1 (barra e dati), R3 per le azioni sul servizio nuovo.
**Barra:** tre script riscritti (`tray-procs.sh`, `tray-access.sh`, `tray-backup.sh`) verdi sulla tray nuova; ogni azione ha un test con servizio finto (freno 2 ore e ripresa, hold 1 ora, budget e priorità salvati, chiusura processo con conferma); `vis affianca` del menu vecchio e nuovo; ok a vista.
**Fuori:** viste AppKit custom se la versione a testo/sottomenu basta all'occhio di Attilio (decisione 2).
**Stima:** 5 h.
