# remote-access Specification

## Purpose
TBD - created by archiving change complete-spec-coverage. Update Purpose after archive.
## Requirements
### Requirement: REMOTE-01 — Tunnel Management

**Status: NOT BUILT** — Already formally withdrawn: `openspec/changes/device-auth/specs/remote-access/spec-removal.md` lists REMOTE-01 under `## REMOVED Requirements` (the tunnel terminated on the machine and forwarded to loopback, which turned the trust boundary inside out). It only still stands here because that change has not been archived. The cure is deleting this requirement, not writing a test for it; the marker keeps the coverage gate from counting it as debt, and the gate fails if a test ever claims it.

The system SHALL provide a remote access panel in the sidebar that displays tunnel status, allows starting and stopping tunnels, shows the public URL with copy and open-in-browser actions, displays the tunnel provider type with color-coded labels, shows expiry information, and auto-refreshes status periodically.

#### Scenario: Panel displays inactive tunnel state
- **GIVEN** the remote access panel is visible in the sidebar
- **WHEN** no tunnel is currently active
- **THEN** the panel SHALL display an Unlink icon with "No active tunnel" text
- **AND** an "Enable Tailscale Funnel" button SHALL be visible

#### Scenario: User starts a tunnel
- **GIVEN** no tunnel is currently active
- **WHEN** the user clicks the "Enable Tailscale Funnel" button
- **THEN** the system SHALL send a POST request to /api/remote/tunnel with { action: "start" }
- **AND** the button SHALL show a spinning loader while the request is in progress
- **AND** the status SHALL refresh after 1 second

#### Scenario: Panel displays active tunnel with public URL
- **GIVEN** a tunnel is active and the server returns a tunnel status with a URL
- **WHEN** the panel renders
- **THEN** the public URL SHALL be displayed in a monospace font within a green-bordered container
- **AND** a Link2 icon SHALL indicate the active connection

#### Scenario: User copies the tunnel URL to clipboard
- **GIVEN** an active tunnel is displayed with its public URL
- **WHEN** the user clicks the Copy button next to the URL
- **THEN** the URL SHALL be copied to the system clipboard
- **AND** the Copy icon SHALL change to a Check icon for 2 seconds

#### Scenario: User opens the tunnel URL in a new browser tab
- **GIVEN** an active tunnel is displayed with its public URL
- **WHEN** the user clicks the external link button next to the URL
- **THEN** a new browser tab SHALL open with the tunnel URL
- **AND** the link SHALL have noopener and noreferrer attributes

#### Scenario: Tunnel provider type displays with color-coded label
- **GIVEN** an active tunnel is displayed
- **WHEN** the tunnel type is "tailscale"
- **THEN** the provider label SHALL display "Tailscale Funnel" in blue text

#### Scenario: Cloudflare tunnel type displays correctly
- **GIVEN** an active tunnel with type "cloudflare"
- **WHEN** the panel renders
- **THEN** the provider label SHALL display "Cloudflare Tunnel" in orange text

#### Scenario: ngrok tunnel type displays correctly
- **GIVEN** an active tunnel with type "ngrok"
- **WHEN** the panel renders
- **THEN** the provider label SHALL display "ngrok" in purple text

#### Scenario: LocalTunnel type displays correctly
- **GIVEN** an active tunnel with type "localtunnel"
- **WHEN** the panel renders
- **THEN** the provider label SHALL display "LocalTunnel" in green text

#### Scenario: Tunnel expiry information displays when available
- **GIVEN** an active tunnel has an expiresAt timestamp
- **WHEN** the panel renders
- **THEN** the expiry date and time SHALL be displayed below the URL in small text
- **AND** the format SHALL be a locale-aware date string

#### Scenario: User stops an active tunnel
- **GIVEN** a tunnel is currently active
- **WHEN** the user clicks the "Disable Tunnel" button
- **THEN** the system SHALL send a POST request to /api/remote/tunnel with { action: "stop" }
- **AND** the button SHALL show a spinning loader while the request is in progress
- **AND** the status SHALL refresh after 1 second

#### Scenario: Panel auto-refreshes tunnel status every 30 seconds
- **GIVEN** the remote access panel is mounted and enabled
- **WHEN** 30 seconds elapse since the last status fetch
- **THEN** the system SHALL automatically fetch the latest tunnel status from GET /api/remote/status

#### Scenario: User manually refreshes tunnel status
- **GIVEN** the remote access panel is visible
- **WHEN** the user clicks the Refresh button at the bottom of the panel
- **THEN** the system SHALL fetch the latest tunnel status from the server
- **AND** the RefreshCw icon SHALL animate (spin) while loading

#### Scenario: Error message displays when tunnel has an error
- **GIVEN** the tunnel status includes an error field
- **WHEN** the panel renders in the inactive state
- **THEN** the error message SHALL be displayed in a red-tinted container below the start button

#### Scenario: Panel does not fetch when disabled
- **GIVEN** the remote access panel is rendered with enabled prop set to false
- **WHEN** the component mounts
- **THEN** the system SHALL NOT poll for tunnel status
- **AND** the auto-refresh interval SHALL NOT be started

