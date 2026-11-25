# Remote browser — the cleanup of closed browsers' data is a setting, at two levels

## ADDED Requirements

### Requirement: BROWSER-STORE-REAP-01 — Level 1 switched off, the reaper removes nothing and asks nothing

When `browserStoreCacheReapEnabled` is `false`, the store reaper SHALL NOT call
`browser_reap_store_caches` nor `browser_reap_data_stores`, and SHALL NOT request
`/api/browsers/data-store-keep-list`, whatever `browserStoreReapEnabled` holds.

#### Scenario: level 1 is off
- **GIVEN** `GET /api/app-settings` answers `browserStoreCacheReapEnabled: false`
- **WHEN** the reaper runs at the start of the desktop app
- **THEN** no Tauri command is invoked and the keep list is never requested

#### Scenario: level 2 left on under a level 1 turned off
- **GIVEN** `browserStoreCacheReapEnabled: false` and `browserStoreReapEnabled: true`
- **WHEN** the reaper runs
- **THEN** nothing is invoked and nothing is requested beyond the settings

### Requirement: BROWSER-STORE-REAP-02 — The age threshold is the setting, inside 7..365 days

The threshold handed to the Tauri command (`maxAgeDays`) SHALL be the stored
`browserStoreReapAfterDays`, the same for both levels. A value outside 7..365
SHALL be brought to the nearest limit, both by `PUT /api/app-settings` when it
is saved and by the reaper before it calls Tauri, and SHALL be rounded to a
whole day (the Tauri commands take an unsigned integer). A value that is not a
number SHALL be refused with a 400.

#### Scenario: the days follow the setting
- **GIVEN** `browserStoreReapAfterDays: 90`
- **WHEN** the reaper runs, at level 1 or at level 2
- **THEN** Tauri receives `maxAgeDays: 90`

#### Scenario: out of range on save
- **WHEN** a PUT writes `browserStoreReapAfterDays: 3`, or `1000`
- **THEN** the stored value is 7, or 365

#### Scenario: a fraction of a day
- **WHEN** a PUT writes `browserStoreReapAfterDays: 14.4`, or the row holds 30.6
- **THEN** the stored value is 14, and Tauri receives `maxAgeDays: 31`

### Requirement: BROWSER-STORE-REAP-03 — Never touched means level 1 on, level 2 off, 60 days

With the three columns NULL (the state every database is in right after the
migration), the reaper SHALL run at level 1 and SHALL hand Tauri
`maxAgeDays: 60`. Level 2 SHALL be on only for an explicit `true`: NULL, a
missing field, `false` and any value that is not the boolean `true` SHALL leave
it off. The reaper SHALL read the setting before it requests the keep list.

#### Scenario: first start after the update
- **GIVEN** `browserStoreCacheReapEnabled`, `browserStoreReapEnabled` and `browserStoreReapAfterDays` are null
- **WHEN** the reaper runs
- **THEN** it requests `/api/app-settings`, then the keep list, then invokes `browser_reap_store_caches` with 60, and never `browser_reap_data_stores`

#### Scenario: a server that does not know the fields
- **GIVEN** the settings object carries none of the three fields
- **WHEN** the reaper runs
- **THEN** it behaves as on first start

### Requirement: BROWSER-STORE-REAP-04 — A setting that did not arrive is not a permission

When `GET /api/app-settings` fails, cannot be reached, or carries no settings
object, the reaper SHALL remove nothing: no keep list request, no Tauri command.
A non-2xx answer SHALL count as a failure even when its body carries settings.

#### Scenario: the server answers 500
- **WHEN** the settings request answers 500
- **THEN** the reaper returns -1 and nothing else is called

#### Scenario: an error status with settings inside
- **WHEN** the settings request answers 500 with `browserStoreReapEnabled: true` in its body
- **THEN** the reaper returns -1 and nothing else is called

### Requirement: BROWSER-STORE-REAP-05 — A read that failed on the server is a failure on the wire

When the server cannot read the settings row (database not open, a busy or
failing SELECT), `GET /api/app-settings` SHALL answer 503 with no `settings`,
never 200 with every field null: null means never touched, which the reaper
reads as level 1 on. `PUT /api/app-settings` SHALL follow the same rule when
its write lands and the read back fails: 503, because the settings panel draws
the PUT answer. The server's own resolvers keep their all-null fallback.

#### Scenario: the SELECT is busy
- **GIVEN** `browserStoreCacheReapEnabled: false` is stored
- **WHEN** the SELECT of `app_settings` throws `SQLITE_BUSY`
- **THEN** the GET answers 503 and the reaper removes nothing

#### Scenario: the write lands, the read back fails
- **GIVEN** `browserStoreReapEnabled: true` and 30 days are stored
- **WHEN** a PUT writes `browserStoreReapEnabled: false` and the SELECT that follows throws
- **THEN** the PUT answers 503 with no `settings`, and the disk holds false and 30

### Requirement: BROWSER-STORE-REAP-06 — The switches show what the reaper reads, and save what was pressed

The panel SHALL draw two switches, the second indented under the first. The
first ("Svuota la cache dei browser chiusi") SHALL be on exactly when level 1
is on (null or `true`) and pressing it SHALL save only
`browserStoreCacheReapEnabled`. The second ("Cancella anche accessi e
cronologia") SHALL be on exactly when `browserStoreReapEnabled` is `true`,
SHALL be disabled while the first is off (still showing what was chosen), and
pressing it SHALL save only `browserStoreReapEnabled`. The days field SHALL show
the resolved days and be disabled while the first is off, and a committed number
of days SHALL be saved clamped to 7..365 and rounded, and not saved when it
equals the stored one. Nothing SHALL be drawn before the stored values are
read. After a save the switches and the field SHALL show the PUT answer, and a
save that failed SHALL show its error line.

#### Scenario: first start
- **GIVEN** the three fields are null
- **WHEN** the rows are drawn
- **THEN** the first switch is on, the second is off and usable, the field shows 60

#### Scenario: level 1 switched off
- **GIVEN** `browserStoreCacheReapEnabled: false`, `browserStoreReapAfterDays: 90`
- **WHEN** the rows are drawn
- **THEN** the first switch is off, the second and the field are disabled, the field shows 90

#### Scenario: pressing a switch writes that switch alone
- **WHEN** the first switch is pressed while the second is on
- **THEN** the PUT body is `{ browserStoreCacheReapEnabled: false }` and nothing else

### Requirement: BROWSER-STORE-REAP-07 — Level 1 empties the cache and never removes a whole store

In `cache` mode the reaper SHALL invoke `browser_reap_store_caches` and only
that command, in every path: when it succeeds, when it throws (an older shell
that does not know it), and when the keep list or the setting fail. It SHALL
NOT fall back to `browser_reap_data_stores` when the new command throws; it
returns -1. On the Rust side `browser_reap_store_caches` SHALL choose the stores
with `stale_store_uuids` (orphan AND idle, floor of 7 days) and SHALL empty only
the types of `CACHE_DATA_TYPE_KEYS`, which SHALL share no key with the identity
types (cookies, localStorage, sessionStorage, indexedDB, webSql) and SHALL name
only known keys. Outside macOS it SHALL return 0 and remove nothing.

#### Scenario: an older shell
- **GIVEN** level 1 and a shell that has no `browser_reap_store_caches`
- **WHEN** the reaper runs and the invoke fails
- **THEN** the reaper returns -1 and `browser_reap_data_stores` is never invoked

#### Scenario: the cache list
- **WHEN** the Rust unit test reads `CACHE_DATA_TYPE_KEYS`
- **THEN** it is not empty, it contains no identity key, and every key is a known data type key

### Requirement: BROWSER-STORE-REAP-08 — Level 2 removes the whole store, only on an explicit true over level 1

In `all` mode (level 1 on AND `browserStoreReapEnabled === true`) the reaper
SHALL invoke `browser_reap_data_stores` and only that command. The server SHALL
store and return both switches, true and false, each independently of the other.

#### Scenario: both on
- **GIVEN** `browserStoreCacheReapEnabled: true` and `browserStoreReapEnabled: true`
- **WHEN** the reaper runs
- **THEN** Tauri receives `browser_reap_data_stores` with the keep list and the days, and `browser_reap_store_caches` is never invoked

#### Scenario: the two columns are independent
- **WHEN** a PUT writes `browserStoreReapEnabled: true` on a row where level 1 was never touched
- **THEN** the answer carries `browserStoreReapEnabled: true` and `browserStoreCacheReapEnabled: null`

### Requirement: BROWSER-STORE-REAP-09 — The keep list goes only to a two-level client, and an empty list or an unreadable age removes nothing

`GET /api/browsers/data-store-keep-list` SHALL answer the list only to a request
that carries `levels=2`, which only the two-level client sends. Without it the
request SHALL go on to `GET /api/browsers/:id` and get the 404
`{"error":"Browser context not found"}` that a desktop shell up to 2.3.23 has
always got: that shell brings its own client, which reads no setting, removes
whole stores on a 200 and removes nothing on a 404. The reaper SHALL ask with
`levels=2`. A keep list with no id SHALL remove nothing: the reaper returns -1
before any Tauri command, and `stale_store_uuids` SHALL pick no store for an
empty `keep_ids`. A store whose age cannot be read (its folder, the listing of
its children, or one child) SHALL NOT be picked.

#### Scenario: an old client
- **WHEN** the keep list is asked without `levels=2` (bare, `levels=1`, `levels=`, `level=2`)
- **THEN** the answer is 404 `{"error":"Browser context not found"}` and no warning is written

#### Scenario: an empty list
- **GIVEN** level 1, or level 1 and level 2, on
- **WHEN** the keep list answers `[]`, or only ids that are empty or not strings
- **THEN** the reaper returns -1 and no Tauri command is invoked

#### Scenario: the Rust selection
- **WHEN** `stale_store_uuids` gets an empty keep list, or a store whose children cannot be listed
- **THEN** it picks no store, at any age
