# The WebKit localStorage journal, and why it reached 5.92 GB

Card `af68a09d`. This page is operational maintenance: nothing here happens by
itself, and nothing here belongs in the code.

## What grows

The desktop shell (Tauri, WKWebView) keeps the app's `localStorage` in a SQLite
database in **WAL mode**:

```
~/Library/WebKit/io.armonia.topics.tauri/WebsiteData/Default/<hash>/<hash>/LocalStorage/
    localstorage.sqlite3
    localstorage.sqlite3-wal      <- this is the one that grows
    localstorage.sqlite3-shm
```

Measured on 2026-09-05 on the machine of whoever uses the app: the `-wal` file
weighed **5.92 GB**, against 5.8 GB two days earlier, so about **100 MB a day**.
The database itself is a handful of megabytes: the quota WebKit gives an origin
is 5 MB and the app lives inside it.

The two facts that make those two numbers compatible:

1. **A WAL file is an append-only journal.** Every `setItem` appends every page
   it dirties. Rewriting the same 1 MB blob a hundred times costs 100 MB of
   journal and zero bytes of database.
2. **WebKit does not checkpoint while the session lives.** A checkpoint folds
   the journal back into the database and truncates it, and WebKit runs one when
   the storage session goes away, which for a desktop app that is never quit
   means: never.

So the cost of `localStorage` here is **how many times you rewrite it**, not how
much you keep in it. That is the opposite of the intuition the quota gives you,
and it is why the quota gate we already had (`messages-cache-*`, capped at 50
messages and 256 KB per entry) did not stop the growth: it caps the size of one
entry, not the number of times that entry is written.

## What the app does about it

Only one thing, and it is a write policy, not a cleanup: the hot caches go
through `client/src/lib/throttledLocalWrite.ts`, which coalesces a burst of
writes into one and skips a write whose bytes are already in storage. See
`STORAGE-WAL-01` in `openspec/specs/performance/spec.md` and, for the numbers on
a real session, `tests/e2e/localstorage-write-volume.spec.ts`.

To find out which key is hot in a real session there is a dev probe,
`client/src/lib/devStorageProbe.ts`. It never runs by itself:

```sh
# arm it, then reload the window and use the app normally for ten minutes
curl -sk -X PUT https://localhost:3333/api/ui-state/dev-storage-probe \
     -H 'content-type: application/json' -d '{"armed":true}'

# read bytes and writes per key, sampled once a minute
curl -sk https://localhost:3333/api/ui-state/dev-storage-probe-result
```

## Reclaiming the space that is already there

A write policy stops the journal from growing. It does not shrink the 5.92 GB
already on disk: only a checkpoint does that, and a checkpoint needs the storage
session closed, which means **the app must be quit**. Not backgrounded: quit.

```sh
# 1. Quit Topics (and any other window of the same webview).
# 2. Fold the journal back into the database and truncate it.
DIR=~/Library/WebKit/io.armonia.topics.tauri/WebsiteData/Default
DB=$(find "$DIR" -name localstorage.sqlite3 | head -1)
ls -lh "$DB"-wal
sqlite3 "$DB" 'PRAGMA wal_checkpoint(TRUNCATE);'
ls -lh "$DB"-wal
```

`wal_checkpoint(TRUNCATE)` returns `0|0|0` when it succeeded. A first column of
`1` means it was blocked: something still holds the database, that is, the app
is still running.

Nothing in the app does this, deliberately. A background job that touches the
storage file of a live webview is a corrupted profile waiting to happen, and the
frequency this needs (once, after months) does not justify the machinery.

**Out of scope.** The browser panes have their own stores under
`WebsiteDataStore/<uuid>/`, with their own journals; they are not this file and
not this card.
