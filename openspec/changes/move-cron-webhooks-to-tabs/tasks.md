## 1. Add Cron to Layout Infrastructure

- [x] 1.1 Extend `handleOpenAsPage` type union in App.tsx to include `'cron'`
- [x] 1.2 Add `cron` entry to `TOPICS_MENU_PAGES` array with Timer icon and "Cron Jobs" label
- [x] 1.3 Add `cron` case to UtilityPanel.tsx, rendering CronJobsPanel as embedded pane content

## 2. Adapt CronJobsPanel for Pane Rendering

- [x] 2.1 Update CronJobsPanel to work as embedded pane content (always enabled, fill available space, remove dropdown-specific sizing)

## 3. Remove Sidebar Dropdown UI

- [x] 3.1 Remove Cron icon button from sidebar header in App.tsx
- [x] 3.2 Remove Webhooks icon button from sidebar header in App.tsx
- [x] 3.3 Remove CronJobsPanel dropdown portal rendering from App.tsx
- [x] 3.4 Remove WebhooksPanel dropdown portal rendering and lazy import from App.tsx
- [x] 3.5 Clean up unused refs (cronBtnRef, cronDropdownRef, webhooksBtnRef, webhooksDropdownRef) and related expandedTool states

## 4. Verify

- [x] 4.1 Verify Topics menu shows "Cron Jobs" item, clicking opens pane tab with working panel
- [x] 4.2 Verify sidebar header no longer shows Cron or Webhooks icons
- [x] 4.3 Verify CronJobsPanel functionality works in pane (list, enable/disable, run, delete, auto-refresh)
