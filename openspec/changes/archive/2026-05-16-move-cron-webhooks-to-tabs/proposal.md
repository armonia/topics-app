## Why

The sidebar header has 5 icon buttons crammed together (Activity, Agents, Cron, Webhooks, Remote Access) plus the "New +" button. Cron Jobs is an admin feature (proxied from OpenClaw gateway) unrelated to topic navigation — it doesn't belong as a sidebar icon. Webhooks is a structural stub: CRUD and test delivery work but real event dispatching is not implemented — the feature is not ready for users and should be removed from the UI entirely.

Moving Cron to the Topics dropdown menu (where Statistics already lives) declutters the header and groups admin features logically. Removing Webhooks eliminates a non-functional feature from the UI.

## What Changes

- **Add Cron Jobs as a menu item** in the Topics dropdown menu (alongside Statistics and Settings)
- **Open Cron as a pane tab** via the existing `handleOpenAsPage` mechanism, rendering a full-width UtilityPanel-style pane instead of a cramped dropdown portal
- **Remove Cron icon button** from the sidebar header row and its dropdown portal rendering
- **Remove Webhooks entirely from the UI** — icon button, dropdown portal, panel component references. Backend API routes remain for future use but are no longer exposed.
- **Clean up** related refs and `expandedTool` states for both tools

## Capabilities

### New Capabilities

_None — this is a reorganization of an existing feature plus removal of an incomplete one._

### Modified Capabilities

- `cron-jobs`: Cron panel moves from sidebar dropdown portal to a full pane tab opened via Topics menu
- `webhooks`: UI removed entirely (panel, sidebar button, dropdown portal). API routes preserved for future implementation.
- `layout`: `handleOpenAsPage` and UtilityPanel gain a new type: `cron`

## Impact

- **client/src/App.tsx**: Remove cron/webhooks sidebar buttons, remove both portal renderings, add cron to `TOPICS_MENU_PAGES`, extend `handleOpenAsPage` type union, remove webhooks lazy import
- **client/src/components/Layout/UtilityPanel.tsx**: Add `cron` panel type, render CronJobsPanel as embedded content
- **client/src/components/Sidebar/CronJobsPanel.tsx**: Adapt for embedded pane rendering (always enabled, fill available space)
- **client/src/components/Sidebar/WebhooksPanel.tsx**: No longer imported anywhere (dead code, can be kept for future use)
- **client/src/types/index.ts**: Remove `webhooks` from SidebarTab type
- **server/routes/webhooks.ts**: Keep as-is (API preserved for future)
