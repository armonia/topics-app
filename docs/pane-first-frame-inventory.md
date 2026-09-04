# What every pane draws on the first frame

A reload is a RETURN: the reader has seen this screen before, so nothing on it
has to be discovered again. Two numbers say whether that holds, and they are
measured together in `tests/e2e/pane-return-cls.spec.ts` (method and arithmetic
in `tests/e2e/helpers/cls-return.ts`, first written for the chat in
`refresh-cls.spec.ts`):

- **CLS** of the return, web-vitals session windows, budget **0.01**.
- **Fullness**: milliseconds from `DOMContentLoaded` to the surface having
  content, budget **100 ms**.

One without the other proves nothing. A pane that paints an empty rectangle for
half a second and then draws the finished layout scores a perfect zero CLS, and
it is exactly the boot the reader was not supposed to watch.

## The surfaces

| Surface | What the first frame draws | Fetches that decide the layout | Local snapshot read synchronously | Verdict |
|---|---|---|---|---|
| Sidebar (topics, groups) | The tree, from the local copy | `GET /api/topics` | `topics-cache`, `workspace-projects-cache` | green |
| Sidebar (unread counters) | The digits from the local copy | WS `unread` frames | `topics-unread-cache` | green |
| Chat (messages) | History from the local copy, curtain up on history + items + images | `GET /api/history/:id` | `messages-cache-<sessionKey>` | green (`refresh-cls.spec.ts`) |
| Composer (model chip, connection pill) | Label and badge from the local copy | `GET /api/providers/snapshot` | `providers-snapshot-cache` | green |
| Topic previews (cards) | Preview text from the local copy | feed | `topic-previews-cache` | green |
| Goal bar | Last known goal | `GET /api/goal/:topic` | `topics-goal-cache:<topicId>` | green |
| Terminal (tab strip + scrollback) | Tabs from the local copy, xterm reattaches to the server buffer | `GET /api/terminal/sessions` | `terminal-sessions-cache` | green (measured) |
| File tree | Tree from the pane state, rows a fixed height | `GET /api/files/tree` | project pane layout in `ui_state` | green (measured) |
| Board / kanban (project mode) | **was:** empty columns until the feed answered | `GET /api/boards/:id/tasks` | **added:** `board-rows-cache:<projectId>|live` | fixed |
| Board / kanban (all projects) | **was:** empty columns until the feed answered | `GET /api/all-boards/tasks` | **added:** `board-rows-cache:all` | fixed |
| Open file (text, code, markdown) | **was:** a centred spinner, then the text | `GET /api/files/content` | **added:** `file-content-cache` (12 files, 128 KB each) | fixed |
| Open file (image, video, PDF) | The viewer chrome, then the media inside a fixed box | `/preview/<path>` | none: the box is sized by the container, not by the media | green on the container, the media itself still arrives when it arrives |
| Browser pane | URL bar, title and favicon from the pane record; the frame is a stream | pane store (local), then the stream | `pane-store-v2` + `browser-history-<topicId>` | not measured here (a server-side Chromium makes it a nightly-only case) |
| Dashboard (KPI, charts) | Nulls, then the numbers | `GET /api/dashboard/*` | none | open: not a pane a reload lands on by default, left out of this pass |
| Notifications | Empty, filled by the socket | WS | none | out: it is an overlay, it decides no layout under it |

## The rule, in one line

Every fetch that decides a height, a width or the presence of a row is a layout
shift already made. What the first frame draws must come from the local copy,
and the fresh data must land in the same geometry.

## What was NOT covered, and why

- **Phone (390 px) on project panes.** At 390 a project shows one pane at a
  time and the file tree is not mounted at all; measuring it there would mean
  driving a navigation the product does not have. The phone is measured where
  the phone lands: chat and board.
- **Browser pane.** Its content is a stream from a server-side Chromium; the
  specs that mount one are nightly-only for that reason. Its chrome (URL,
  title, favicon) already comes from the local pane record.
- **Dashboard.** No local snapshot today. It is a surface you open, not one a
  reload lands on, so it is named here rather than fixed in this pass.
