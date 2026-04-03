## Context

The sidebar header currently renders 5 icon buttons (Activity, Agents, Cron, Webhooks, Remote Access) plus a "New +" menu button. Cron Jobs opens as a floating dropdown portal anchored to its sidebar icon — it proxies to the OpenClaw gateway and is fully functional. Webhooks also opens as a dropdown portal but investigation revealed it's an incomplete stub: CRUD + test delivery work, but real event dispatching is not implemented (the `webhook_deliveries` table is never written to, no code fires webhooks on actual events).

Activity and Agents already open as full pane tabs via `handleOpenAsPage`. The Topics dropdown menu currently contains only "Statistics" (dashboard) and "Settings".

## Goals / Non-Goals

**Goals:**
- Move Cron Jobs into the Topics dropdown menu as a new menu item, opening as a pane tab
- Remove Webhooks from the UI entirely (it's a non-functional stub)
- Keep all existing Cron Jobs functionality intact (list, enable/disable, run, delete, auto-refresh)
- Keep webhooks API routes for future use when event dispatching is implemented

**Non-Goals:**
- Changing the Remote Access feature (stays as sidebar icon + dropdown)
- Implementing real webhook event dispatching (separate future work)
- Redesigning the CronJobsPanel internal UI
- Adding new Cron Jobs functionality (e.g., job creation UI)

## Decisions

### D1: Reuse `handleOpenAsPage` + UtilityPanel pattern for Cron

The existing pattern opens utility panels as panes with IDs like `__dashboard__`, `__activity__`. We extend this to `__cron__`.

**Why:** Consistent with how Activity, Agents, and Dashboard already work. Zero new infrastructure needed.

### D2: Add Cron to `TOPICS_MENU_PAGES` array

Cron becomes an entry in the `TOPICS_MENU_PAGES` constant at App.tsx:45, alongside the existing "Statistics" (dashboard) entry.

**Why:** This is the declarative menu definition — adding an entry here automatically renders the menu item with click-to-open behavior.

### D3: Remove Webhooks UI completely, keep backend

The WebhooksPanel component file stays in the codebase but is no longer imported or rendered. The server API routes (`/api/webhooks/*`) remain functional.

**Why:** The backend is correct and tested. When real event dispatching is implemented, the UI can be restored and improved. Deleting files would create unnecessary churn.

### D4: Adapt CronJobsPanel for embedded pane rendering

The panel currently receives an `enabled` prop (true only when dropdown is open). As pane content, it should always be enabled and fill available space.

**Why:** Dropdown panels conditionally fetch only when visible. As pane content, they should fetch on mount.

## Risks / Trade-offs

- **Discoverability of Cron**: Users accustomed to the sidebar icon may not find it in the Topics menu → Low risk, the Timer icon was already cryptic; a labeled menu item is clearer.
- **Panel sizing**: Dropdown panel is narrow (~300px); pane is full-width → Panel already uses flex layout, should adapt with minor CSS tweaks if needed.
- **Webhooks removal**: Users who configured webhooks via the UI will no longer see the management panel → Acceptable since webhooks never fired on real events anyway. API still accessible.
