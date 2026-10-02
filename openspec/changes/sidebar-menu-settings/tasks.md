# Tasks: sidebar-menu-settings

Prima del codice: `grep -qx 'status: approved' openspec/changes/sidebar-menu-settings/.openspec.yaml`.
Se esce non-zero, ci si ferma qui.

## 1. Test rossi sul tree di oggi

- [x] 1.1 `client/src/lib/settingsHomes.test.ts` (bun:test): una tabella `SETTINGS_HOMES` (chiave di `AppSettings` → superficie) e il test che fallisce su una chiave senza casa o con due; oggi rosso su `voiceMode` e `keepLiveSites` (USERMENU-06).
- [x] 1.2 `client/src/components/Settings/sections.test.ts`: le voci sono esattamente `providers`, `tools`, `calendar`, `plan`, `nodes`, tradotte nelle due lingue (USERMENU-06, APPSET-05).
- [x] 1.3 `client/src/components/Shared/Segmented.test.tsx` e `Stepper.test.tsx`: ruoli `radiogroup`/`spinbutton`, frecce, limiti, nessuna durata scritta a mano (USERMENU-07, USERMENU-08).
- [x] 1.4 `tests/e2e/user-menu-preferences.spec.ts` su `:13334`: tema dal livello Aspetto con il menu che resta aperto e `ui-state/theme` riletto; passo del testo da tastiera; Vista con l'ordine attivo leggibile e la riga della board; livello Notifiche dall'ingranaggio del campanello senza `settings-panel`, con il tasto del permesso dei banner (stato finto «non ancora deciso»), «Questo dispositivo» con `push-when-open-*` e `push-unsubscribe`, «Altri dispositivi»; progetto silenziato e riattivato (USERMENU-01…03, NOTIF-PERM-01). Prima guarda `profile-menu.spec.ts` e `sidebar-status-in-menu.spec.ts` e riusa `openProfileMenu`.
  Fatto: `tests/e2e/user-menu-preferences.spec.ts`. Il tasto del permesso con lo stato finto «non ancora deciso» NON è nell'E2E: lo stato si legge solo dal guscio Tauri, e fingere `__TAURI_INTERNALS__` manda le chiamate al proxy della app vera su 127.0.0.1:13333; resta coperto da `lib/notificationStatus.test.ts` (la scelta del tasto) e il livello lo monta.
- [x] 1.5 Stesso spec: dispositivi rinominati e revocati dal livello con `/api/auth/devices` finto come in `profile-menu.spec.ts:58-76`; il computer senza matita né cestino; «Revocati» compare dopo la revoca; con due persone «Di chi è» sposta il dispositivo, con una non c'è; la voce Nodi delle Impostazioni ha `settings-node-pair` (USERMENU-04, USERMENU-06).
- [x] 1.6 Stesso spec: `openSettings('organization')` apre la tab Profilo; il pannello «Persone» ha `list-people`; il pannello «Fuori da Topics» ha `profile-public-publish`, il costo e la presenza Discord, e una revoca rifiutata mostra `profile-public-error` (USERMENU-05, APPSET-07); nessun campo di accesso fuori dal menu (USERMENU-05).
- [x] 1.7 Tastiera dal primo livello fino al segmento del tema; 390x844 col foglio e i bersagli da 44 px (USERMENU-07). Guardia macchina prima di ogni corsa: carico a 1 minuto sotto 18, `memory_pressure` libero almeno al 20%.
  Fatto con una differenza: freccia destra apre il livello col fuoco sul pannello, come ogni livello di `Menu`; una freccia giù porta al segmento del tema (scenario aggiornato nel delta). La parte del telefono (foglio, 44 px) sta nel test di USERMENU-09, stessa larghezza.
- [x] 1.8 Stesso spec a 390x844: dal menu del titolo si accede e si esce (blocco account), si rinomina e si revoca un dispositivo (USERMENU-09). Finché non è verde, 4.1 e 4.2 non tolgono `AccountSection` né la pagina Dispositivi.

## 2. Primitive

- [x] 2.1 `Shared/Segmented.tsx` (radiogroup, indicatore che scorre in `--motion-instant`) e `Shared/Stepper.tsx` (spinbutton), sopra i token di `index.css`, nessuna durata letterale.
- [x] 2.2 `PresencePopover.tsx`: frecce, Home, End sul primo livello con la stessa logica di `useMenuKeyboard`.
- [x] 2.3 `SubmenuItem.tsx`: `defaultOpen`; evento `topics:open-user-menu` con `detail.level` ascoltato da `IdentityBlock` e dal menu del titolo.
- [x] 2.4 `Sidebar/IdentityMenuItems.tsx`: il blocco account, Amici, Gruppi, Dispositivi estratto da `ProfileMenu.tsx`, con i dati di `IdentityBlock` in un hook; montato nella card del desktop e in cima al menu del titolo del telefono (`App.tsx`), letto solo a menu aperto.

## 3. Livelli del menu

- [x] 3.1 `Sidebar/AppearanceLevel.tsx` montato da `TopicsMenuItems` (quindi su desktop e telefono), coda con lo stato.
- [x] 3.2 `Sidebar/NotificationsLevel.tsx`: gli interruttori, `NativeBannerStatus` e `FocusGateStatus` spostati da `NotificationsSection.tsx`, `PushDevices` diviso nei livelli «Questo dispositivo» e «Altri dispositivi» con gli stessi `data-testid`, i progetti silenziati; ingranaggio del campanello verso `topics:open-user-menu`.
- [x] 3.3 Vista: `Shared/Switch` per Archiviati, segmento per l'ordine, Riga della board.
- [x] 3.4 Dispositivi: `lib/devicesApi.ts` estratto da `Settings/DevicesSection.tsx`; rinomina, revoca e «Di chi è» (solo con più persone) nel livello; livello figlio «Revocati»; riga delle richieste remote verso Impostazioni, Nodi.
- [x] 3.5 Sistema, Prestazioni: i siti sempre attivi con «Togli».

## 4. Togliere i doppioni

- [x] 4.1 `Settings/sections.ts` e `GlobalSettings.tsx`: cinque voci; `devices` diventa `nodes`, cioè `Settings/NodesSection.tsx` con il riquadro Nodi di `DevicesSection.tsx:568-640` (`settings-node-pair`, MACHINE-02) e `RemoteNodeRequests`; titolo dal dizionario.
- [x] 4.2 `Settings/IdentityPages.tsx`: via `ProfilePage` e `FollowersPage` dal pannello; `OrganizationPage` resta per la tab. `AccountSection.tsx` rimosso solo con 1.8 verde.
- [x] 4.3 `Profile/SelfProfile.tsx`: `ProfilePanel` guadagna `people` (lo stesso `PeopleList`, `list-people`) e `outside` («Fuori da Topics»: `ProfileStatsSection` intero e `DiscordSection`, spostati sotto `Profile/`). `Profile/PrivacySection.tsx`: `Shared/Switch` al posto dell'interruttore privato.
  Differenza: `ProfileStatsSection.tsx` e `DiscordSection.tsx` restano in `Settings/` e la tab Profilo li importa da lì. Spostarli sotto `Profile/` fa contare come nuove le loro 84 righe di commento in italiano e 12 nomi (`check:comment-language`, `check:identifier-language`), che non si alzano.
- [x] 4.4 `lib/openSettings.ts`: le sezioni tolte reindirizzano (`apriProfilo`, `topics:open-user-menu`); `SettingsPanelSection` ristretto, `tsc` trova i chiamanti.
- [x] 4.5 `Shared/CommandPalette.tsx`: pill del tema con l'icona e il nome del tema attuale.
- [x] 4.6 `voiceMode` fuori da `types/index.ts`, `lib/settings.ts`, `hooks/useVoiceLoop.ts` (il ciclo vocale resta spento come oggi).
- [x] 4.7 i18n: ogni etichetta nuova o spostata in `i18n-it.ts` e `i18n-en.ts`.
- [x] 4.8 E2E che entrano da una voce tolta: cambiano la porta, non l'asserzione (`settings-profile-devices`, `profile-followers`, `profile-discord`, `refused-gestures`, `push-phone-enroll`, `settings-mobile`, `settings-lingua-org`, `org-presence`, `org-projects-scope`, `profile-menu`).

## 5. Verifica

- [x] 5.1 I test del §1 verdi; `bun run typecheck`, `typecheck:e2e`, `lint`, i `check:*` di `ci.yml` (in particolare `check:ui-language`, `check:typography`, `check:deadcode`), `build:client` e `check:bundle`.
- [x] 5.2 Video `.webm` WebKit dell'E2E 1.4 (tema, testo, notifiche dal campanello) e screenshot chiaro e scuro dei livelli, accanto a quelli di oggi in `screenshots/`.
- [x] 5.3 `bunx --bun @fission-ai/openspec@latest validate sidebar-menu-settings` esce 0.

## Note dell'implementazione

- I corpi dei livelli Aspetto, Notifiche e Vista, il blocco dell'identità del telefono e le righe del menu del titolo si caricano a parte (`lazy`/`lazyWarm`, scaldati appena il layout del telefono è su): dentro l'entry il budget di `check:bundle` sul percorso critico non aveva margine. 42 chiavi del dizionario rimaste orfane delle pagine tolte escono con loro.
- `popoverRegistry`: un selettore dentro un livello aperto da una riga del menu chiudeva il menu (il «nonno»), perché il suo trigger non sta nel pannello del menu ma nel livello. Ora il parente si cerca lungo la catena dei livelli aperti, in `popoversToClose` e in `descendantPopoverNodes` (test in `popoverRegistry.test.ts`).
- Larghezza chat: «Piena» è il passo dopo 1300, all'estremo del «+».
- Extra deciso a parte: il cassetto di progetto del telefono entra con `.drawer-enter` e esce con la copia `drawer` di `lib/exitGhost`; tolto dalle eccezioni di `floatingSurfaces.test.ts`.
