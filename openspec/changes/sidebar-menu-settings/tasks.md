# Tasks: sidebar-menu-settings

Prima del codice: `grep -qx 'status: approved' openspec/changes/sidebar-menu-settings/.openspec.yaml`.
Se esce non-zero, ci si ferma qui.

## 1. Test rossi sul tree di oggi

- [ ] 1.1 `client/src/lib/settingsHomes.test.ts` (bun:test): una tabella `SETTINGS_HOMES` (chiave di `AppSettings` → superficie) e il test che fallisce su una chiave senza casa o con due; oggi rosso su `voiceMode` e `keepLiveSites` (USERMENU-06).
- [ ] 1.2 `client/src/components/Settings/sections.test.ts`: le voci sono esattamente `providers`, `tools`, `calendar`, `plan`, `remote-computers`, tradotte nelle due lingue (USERMENU-06, APPSET-05).
- [ ] 1.3 `client/src/components/Shared/Segmented.test.tsx` e `Stepper.test.tsx`: ruoli `radiogroup`/`spinbutton`, frecce, limiti, nessuna durata scritta a mano (USERMENU-07, USERMENU-08).
- [ ] 1.4 `tests/e2e/user-menu-preferences.spec.ts` su `:13334`: tema dal livello Aspetto con il menu che resta aperto e `ui-state/theme` riletto; passo del testo da tastiera; Vista con l'ordine attivo leggibile e la riga della board; livello Notifiche dall'ingranaggio del campanello senza `settings-panel`; progetto silenziato e riattivato (USERMENU-01…03). Prima guarda `profile-menu.spec.ts` e `sidebar-status-in-menu.spec.ts` e riusa `openProfileMenu`.
- [ ] 1.5 Stesso spec: dispositivi rinominati e revocati dal livello con `/api/auth/devices` finto come in `profile-menu.spec.ts:58-76`; il computer senza matita né cestino; «Revocati» compare dopo la revoca (USERMENU-04).
- [ ] 1.6 Stesso spec: `openSettings('organization')` apre la tab Profilo; nessun campo di accesso fuori dal menu (USERMENU-05).
- [ ] 1.7 Tastiera dal primo livello fino al segmento del tema; 390x844 col foglio e i bersagli da 44 px (USERMENU-07). Guardia macchina prima di ogni corsa: carico a 1 minuto sotto 18, `memory_pressure` libero almeno al 20%.

## 2. Primitive

- [ ] 2.1 `Shared/Segmented.tsx` (radiogroup, indicatore che scorre in `--motion-instant`) e `Shared/Stepper.tsx` (spinbutton), sopra i token di `index.css`, nessuna durata letterale.
- [ ] 2.2 `PresencePopover.tsx`: frecce, Home, End sul primo livello con la stessa logica di `useMenuKeyboard`.
- [ ] 2.3 `SubmenuItem.tsx`: `defaultOpen`; evento `topics:open-user-menu` con `detail.level` ascoltato da `IdentityBlock` e dal menu del titolo.

## 3. Livelli del menu

- [ ] 3.1 `Sidebar/AppearanceLevel.tsx` montato da `TopicsMenuItems` (quindi su desktop e telefono), coda con lo stato.
- [ ] 3.2 `Sidebar/NotificationsLevel.tsx`: gli interruttori, lo stato push estratto da `NotificationsSection.tsx` (`PushDevices`), i progetti silenziati; ingranaggio del campanello verso `topics:open-user-menu`.
- [ ] 3.3 Vista: `Shared/Switch` per Archiviati, segmento per l'ordine, Riga della board.
- [ ] 3.4 Dispositivi: `lib/devicesApi.ts` estratto da `Settings/DevicesSection.tsx`; rinomina e revoca nel livello; livello figlio «Revocati»; riga delle richieste remote.
- [ ] 3.5 Sistema, Prestazioni: i siti sempre attivi con «Togli».

## 4. Togliere i doppioni

- [ ] 4.1 `Settings/sections.ts` e `GlobalSettings.tsx`: cinque voci; `devices` diventa `remote-computers` con solo `RemoteNodeRequests`; titolo dal dizionario.
- [ ] 4.2 `Settings/IdentityPages.tsx`: via `ProfilePage` e `FollowersPage` dal pannello; `OrganizationPage` resta per la tab. `AccountSection.tsx` rimosso.
- [ ] 4.3 `Profile/PrivacySection.tsx`: «Fuori da Topics» con `DiscordSection` e il costo; `Shared/Switch` al posto dell'interruttore privato.
- [ ] 4.4 `lib/openSettings.ts`: le sezioni tolte reindirizzano (`apriProfilo`, `topics:open-user-menu`); `SettingsPanelSection` ristretto, `tsc` trova i chiamanti.
- [ ] 4.5 `Shared/CommandPalette.tsx`: pill del tema con l'icona e il nome del tema attuale.
- [ ] 4.6 `voiceMode` fuori da `types/index.ts`, `lib/settings.ts`, `hooks/useVoiceLoop.ts` (il ciclo vocale resta spento come oggi).
- [ ] 4.7 i18n: ogni etichetta nuova o spostata in `i18n-it.ts` e `i18n-en.ts`.

## 5. Verifica

- [ ] 5.1 I test del §1 verdi; `bun run typecheck`, `typecheck:e2e`, `lint`, i `check:*` di `ci.yml` (in particolare `check:ui-language`, `check:typography`, `check:deadcode`), `build:client` e `check:bundle`.
- [ ] 5.2 Video `.webm` WebKit dell'E2E 1.4 (tema, testo, notifiche dal campanello) e screenshot chiaro e scuro dei livelli, accanto a quelli di oggi in `screenshots/`.
- [ ] 5.3 `bunx --bun @fission-ai/openspec@latest validate sidebar-menu-settings` esce 0.
