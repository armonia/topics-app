## ADDED Requirements

### Requirement: CMD-02 — Push Notifications

The system SHALL support browser push notification subscription management with VAPID key exchange, subscribe and unsubscribe flows, permission state handling, and graceful degradation for unsupported browsers.

#### Scenario: Unsupported browser sets state to unsupported
- **GIVEN** the browser does not support ServiceWorker or PushManager APIs
- **WHEN** the push notifications hook initializes
- **THEN** the push state is set to "unsupported"
- **AND** subscribe and unsubscribe actions are effectively no-ops

#### Scenario: Denied permission sets state to denied
- **GIVEN** the browser supports push notifications
- **WHEN** the Notification.permission is "denied"
- **THEN** the push state is set to "denied"
- **AND** calling subscribe has no effect

#### Scenario: Default permission with no subscription sets state to default
- **GIVEN** the browser supports push notifications
- **WHEN** the notification permission is "default" and no existing subscription exists
- **THEN** the push state is set to "default"

#### Scenario: Existing subscription sets state to subscribed
- **GIVEN** the browser supports push notifications and permission is granted
- **WHEN** an existing push subscription is found via PushManager
- **THEN** the push state is set to "subscribed"

#### Scenario: Subscribe requests notification permission
- **GIVEN** the push state is "default"
- **WHEN** the user triggers the subscribe action
- **THEN** the browser permission prompt is displayed via Notification.requestPermission
- **AND** a loading state is set to true during the process

#### Scenario: Subscribe fetches VAPID public key from server
- **GIVEN** the user grants notification permission
- **WHEN** the subscribe flow continues
- **THEN** a request is made to /api/push/vapid-public-key to retrieve the server public key
- **AND** the key is converted to a Uint8Array for PushManager subscription

#### Scenario: Subscribe registers subscription with server
- **GIVEN** the VAPID key has been retrieved and a PushManager subscription is created
- **WHEN** the subscription object is ready
- **THEN** a POST request is sent to /api/push/subscribe with the subscription JSON
- **AND** the push state changes to "subscribed"

#### Scenario: Subscribe sets denied state when permission refused
- **GIVEN** the push state is "default"
- **WHEN** the user denies the notification permission prompt
- **THEN** the push state changes to "denied"
- **AND** the loading state returns to false

#### Scenario: Unsubscribe removes subscription from browser and server
- **GIVEN** the push state is "subscribed"
- **WHEN** the user triggers the unsubscribe action
- **THEN** a POST request is sent to /api/push/unsubscribe with the subscription endpoint
- **AND** the browser PushManager subscription is unsubscribed
- **AND** the push state changes to "default"

#### Scenario: Unsubscribe shows loading state during process
- **GIVEN** the user triggers unsubscribe
- **WHEN** the unsubscription is in progress
- **THEN** the loading flag is set to true
- **AND** loading returns to false once the process completes

#### Scenario: Subscribe error is logged without crashing
- **GIVEN** the subscribe flow encounters a network or API error
- **WHEN** the error occurs during VAPID key fetch or subscription registration
- **THEN** the error is logged to the console
- **AND** the loading state returns to false
- **AND** the push state does not change to "subscribed"
