# Remote browser — the cleanup of closed browsers' data is a setting

## ADDED Requirements

### Requirement: BROWSER-STORE-REAP-01 — Switched off, the reaper removes nothing and asks nothing

When `browserStoreReapEnabled` is `false`, the store reaper SHALL NOT call
`browser_reap_data_stores` and SHALL NOT request
`/api/browsers/data-store-keep-list`.

#### Scenario: the switch is off
- **GIVEN** `GET /api/app-settings` answers `browserStoreReapEnabled: false`
- **WHEN** the reaper runs at the start of the desktop app
- **THEN** no Tauri command is invoked and the keep list is never requested

### Requirement: BROWSER-STORE-REAP-02 — The age threshold is the setting, inside 7..365 days

The threshold handed to `browser_reap_data_stores` (`maxAgeDays`) SHALL be the
stored `browserStoreReapAfterDays`. A value outside 7..365 SHALL be brought to
the nearest limit, both by `PUT /api/app-settings` when it is saved and by the
reaper before it calls Tauri, and SHALL be rounded to a whole day (the Tauri
command takes an unsigned integer). A value that is not a number SHALL be
refused with a 400.

#### Scenario: the days follow the setting
- **GIVEN** `browserStoreReapAfterDays: 90`
- **WHEN** the reaper runs
- **THEN** Tauri receives `maxAgeDays: 90`

#### Scenario: out of range on save
- **WHEN** a PUT writes `browserStoreReapAfterDays: 3`, or `1000`
- **THEN** the stored value is 7, or 365

#### Scenario: a fraction of a day
- **WHEN** a PUT writes `browserStoreReapAfterDays: 14.4`, or the row holds 30.6
- **THEN** the stored value is 14, and Tauri receives `maxAgeDays: 31`

### Requirement: BROWSER-STORE-REAP-03 — Never touched means on, after 60 days

With both columns NULL (the state every database is in right after the
migration), the reaper SHALL run, and SHALL hand Tauri `maxAgeDays: 60`. It
SHALL read the setting before it requests the keep list.

#### Scenario: first start after the update
- **GIVEN** `browserStoreReapEnabled` and `browserStoreReapAfterDays` are null
- **WHEN** the reaper runs
- **THEN** it requests `/api/app-settings`, then the keep list, then invokes Tauri with 60

### Requirement: BROWSER-STORE-REAP-04 — A setting that did not arrive is not a permission

When `GET /api/app-settings` fails, cannot be reached, or carries no settings
object, the reaper SHALL remove nothing: no keep list request, no Tauri command.

#### Scenario: the server answers 500
- **WHEN** the settings request answers 500
- **THEN** the reaper returns -1 and nothing else is called

### Requirement: BROWSER-STORE-REAP-05 — A read that failed on the server is a failure on the wire

When the server cannot read the settings row (database not open, a busy or
failing SELECT), `GET /api/app-settings` SHALL answer 503 with no `settings`,
never 200 with every field null: null means never touched, which the reaper
reads as on. The server's own resolvers keep their all-null fallback.

#### Scenario: the SELECT is busy
- **GIVEN** `browserStoreReapEnabled: false` is stored
- **WHEN** the SELECT of `app_settings` throws `SQLITE_BUSY`
- **THEN** the GET answers 503 and the reaper removes nothing

### Requirement: BROWSER-STORE-REAP-06 — The switch shows what the reaper reads, and saves what was pressed

The switch SHALL be on exactly when the reaper would run (null or `true`), the
days field SHALL show the resolved days and be disabled while off, pressing the
switch SHALL save only `browserStoreReapEnabled`, and a committed number of
days SHALL be saved clamped to 7..365 and rounded, and not saved when it equals
the stored one. Nothing SHALL be drawn before the stored values are read.

#### Scenario: switched off
- **GIVEN** `browserStoreReapEnabled: false`, `browserStoreReapAfterDays: 90`
- **WHEN** the rows are drawn
- **THEN** the switch is off, the field shows 90 and is disabled
