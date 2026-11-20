# Delta: remote-access — per-device authentication

## ADDED Requirements

### Requirement: AUTH-04 — The identity is visible

When the current session belongs to an authorized device, the interface SHALL show
which device it is, above the status bar. On the machine the server runs on the
interface SHALL show nothing, because there the identity is the premise rather than
information.

A device that is not authorized SHALL be told so plainly, with the gesture that
resolves it, rather than being left in an indefinite connecting state.

#### Scenario: An authorized device shows its name
- **GIVEN** the session belongs to an authorized device
- **WHEN** the interface renders
- **THEN** the device's name SHALL be visible above the status bar

#### Scenario: The local machine shows nothing
- **GIVEN** the session is trusted by transport
- **WHEN** the interface renders
- **THEN** no device identity SHALL be shown

#### Scenario: An unauthorized device is not left waiting silently
- **GIVEN** a device that is not authorized
- **WHEN** it opens the app
- **THEN** it SHALL be told it is not authorized
- **AND** SHALL be shown what to do about it
