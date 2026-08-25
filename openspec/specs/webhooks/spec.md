# webhooks Specification

## Purpose
TBD - created by archiving change complete-spec-coverage. Update Purpose after archive.
## Requirements
### Requirement: WEBHOOK-01 — Webhook Management

**Status: NOT BUILT** — The `/api/webhooks` CRUD this describes has no route, no table and no handler. The only webhook in the codebase is the Stripe one in `server/routes/billing.ts`, which is a different thing and is tested. The cure is deleting this requirement, not writing a test for it; the marker keeps the coverage gate from counting it as debt, and the gate fails if a test ever claims it.

The system SHALL provide a webhook management API that supports creating, listing, updating, and deleting webhooks with configurable event subscriptions, HMAC-SHA256 signed test deliveries, retry and timeout settings, and persistent storage in SQLite.

#### Scenario: List all webhooks
- **GIVEN** one or more webhooks exist in the database
- **WHEN** a GET request is sent to /api/webhooks
- **THEN** the server SHALL return a JSON object with a "webhooks" array containing all webhooks ordered by creation date descending

#### Scenario: List webhooks returns empty array when none exist
- **GIVEN** no webhooks exist in the database
- **WHEN** a GET request is sent to /api/webhooks
- **THEN** the server SHALL return { webhooks: [] }

#### Scenario: Create a new webhook with required fields
- **GIVEN** a valid name and URL are provided
- **WHEN** a POST request is sent to /api/webhooks with { name, url }
- **THEN** the server SHALL create a new webhook with a generated UUID
- **AND** a random secret SHALL be auto-generated
- **AND** the webhook SHALL be active by default
- **AND** the response SHALL return the created webhook with HTTP status 201

#### Scenario: Create a webhook with all optional fields
- **GIVEN** a POST request includes name, url, secret, events, active, retryCount, and timeoutMs
- **WHEN** the webhook is created
- **THEN** all provided values SHALL be stored as specified
- **AND** the events array SHALL be persisted as JSON

#### Scenario: Create webhook fails without required fields
- **GIVEN** a POST request is missing the name or url field
- **WHEN** the request is sent to /api/webhooks
- **THEN** the server SHALL return HTTP 400 with error "name and url required"

#### Scenario: Webhook defaults retryCount to 5 and timeoutMs to 5000
- **GIVEN** a POST request does not include retryCount or timeoutMs
- **WHEN** the webhook is created
- **THEN** the retryCount SHALL default to 5
- **AND** the timeoutMs SHALL default to 5000

#### Scenario: Update a webhook with partial fields
- **GIVEN** a webhook exists with a known ID
- **WHEN** a PATCH request is sent to /api/webhooks/:id with partial fields (e.g., { name: "Updated" })
- **THEN** only the provided fields SHALL be updated
- **AND** unspecified fields SHALL retain their existing values
- **AND** the updatedAt timestamp SHALL be refreshed

#### Scenario: Update webhook fails for non-existent ID
- **GIVEN** no webhook exists with the specified ID
- **WHEN** a PATCH request is sent to /api/webhooks/:id
- **THEN** the server SHALL return HTTP 404 with error "Webhook not found"

#### Scenario: Update webhook fails without request body
- **GIVEN** a webhook exists
- **WHEN** a PATCH request is sent with no body
- **THEN** the server SHALL return HTTP 400 with error "body required"

#### Scenario: Delete a webhook
- **GIVEN** a webhook exists with a known ID
- **WHEN** a DELETE request is sent to /api/webhooks/:id
- **THEN** the webhook SHALL be removed from the database
- **AND** the response SHALL return { ok: true }

#### Scenario: Delete webhook fails for non-existent ID
- **GIVEN** no webhook exists with the specified ID
- **WHEN** a DELETE request is sent to /api/webhooks/:id
- **THEN** the server SHALL return HTTP 404 with error "Webhook not found"

#### Scenario: Test delivery sends a signed POST to the webhook URL
- **GIVEN** a webhook exists with a known ID and URL
- **WHEN** a POST request is sent to /api/webhooks/:id/test
- **THEN** the server SHALL send a POST request to the webhook URL with a test payload
- **AND** the payload SHALL include event "webhook.test", a delivery ID, and a timestamp
- **AND** the request SHALL include X-Webhook-Event, X-Webhook-Delivery, and X-Webhook-Signature headers

#### Scenario: Test delivery computes HMAC-SHA256 signature using webhook secret
- **GIVEN** a webhook has a configured secret
- **WHEN** a test delivery is triggered
- **THEN** the X-Webhook-Signature header SHALL contain an HMAC-SHA256 hex digest computed from the request body using the webhook secret

#### Scenario: Test delivery returns success status on HTTP 2xx response
- **GIVEN** the webhook endpoint responds with a 2xx status code
- **WHEN** the test delivery completes
- **THEN** the response SHALL include { status: "success", httpStatus: <code>, deliveryId }

#### Scenario: Test delivery returns failed status on non-2xx response
- **GIVEN** the webhook endpoint responds with a non-2xx status code
- **WHEN** the test delivery completes
- **THEN** the response SHALL include { status: "failed", httpStatus: <code>, deliveryId }

#### Scenario: Test delivery returns failed status on network error
- **GIVEN** the webhook URL is unreachable or times out
- **WHEN** the test delivery fails
- **THEN** the response SHALL include { status: "failed", httpStatus: null, error: <message>, deliveryId }

#### Scenario: Test delivery respects the webhook timeout setting
- **GIVEN** a webhook has a configured timeoutMs value
- **WHEN** a test delivery is triggered
- **THEN** the HTTP request to the webhook URL SHALL use an AbortSignal with the configured timeout

#### Scenario: Test delivery fails for non-existent webhook
- **GIVEN** no webhook exists with the specified ID
- **WHEN** a POST request is sent to /api/webhooks/:id/test
- **THEN** the server SHALL return HTTP 404 with error "Webhook not found"

#### Scenario: Webhook data model includes all expected fields
- **GIVEN** a webhook is created and retrieved
- **WHEN** the webhook object is returned in any API response
- **THEN** it SHALL include id, name, url, secret, events (array), active (boolean), retryCount, timeoutMs, createdAt, and updatedAt fields

