# R3 — Letture per la tray e per il ponte

**Cosa:** nel servizio le letture che la tray e il ponte chiedono: `/api/machines`, `/api/board`, `/api/mac`, `/api/mac/trust`, `/api/mac/procs` (e la chiusura sicura di un processo, con controllo dell'istante di nascita), `/api/automations/summary`, `/api/project-settings` (GET e POST), `/api/alerts`, `/api/forecast`, `/api/services`, `/api/pc`.
**Da fare:** stesse risposte del vecchio; il censimento processi si rifà al più ogni 30 secondi e solo se qualcuno legge; backup del Mac letto da `state/backup-mac.json` (anche senza altri dati).
**Può restare nel server Bun di Topics (consultazione, tollera Topics giù):** `/api/diario`, `/api/contesto`, `/api/features`, `/api/calendar`, `/api/projects`, `/api/automations` completo e `run`, `/api/hub-config`, `/api/policy`, `/api/chat-priority`, e da switchboard `/api/activity`, `/api/sessions`, `/api/api-profiles`, `/api/remove`, `/api/logs/stream`.
**Dipendenze:** R1.
**Barra:** `golden-diff` verde sugli endpoint elencati; chiusura processo: pid riusato rifiutato, SIGTERM poi SIGKILL, non tocca processi di sistema (test su processo finto); `footprint-bar` ancora verde con il censimento attivo.
**Fuori:** moduli che calcolano pesante (restano script chiamati a richiesta).
**Stima:** 4 h.
