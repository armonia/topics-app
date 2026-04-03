## REMOVED Requirements

### Requirement: WEBHOOK-01 — Webhook Management

**Reason**: The webhook UI is a structural stub — CRUD and test delivery work, but real event dispatching is not implemented (no code fires webhooks on `topic.created`, `chat.message`, etc.). The `webhook_deliveries` table is never written to. Removing the UI eliminates a non-functional feature. Backend API routes at `/api/webhooks/*` are preserved for future implementation.

**Migration**: When real event dispatching is implemented, restore the WebhooksPanel UI (component file preserved in codebase) and add it back to the Topics menu as a pane tab.
