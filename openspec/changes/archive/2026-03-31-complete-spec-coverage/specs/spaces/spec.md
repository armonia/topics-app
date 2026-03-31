## ADDED Requirements

### Requirement: SPACE-01 — Project Organization

The system SHALL provide a spaces management API for organizing topics into project spaces, supporting CRUD operations on spaces, switching the active space, managing space members, creating and revoking invite codes, and persisting space data to a JSON file.

#### Scenario: List all spaces
- **GIVEN** one or more spaces exist in the spaces.json file
- **WHEN** a GET request is sent to /api/spaces
- **THEN** the server SHALL return a JSON array of all spaces

#### Scenario: List spaces returns empty array when none exist
- **GIVEN** no spaces.json file exists or it contains no spaces
- **WHEN** a GET request is sent to /api/spaces
- **THEN** the server SHALL return an empty array

#### Scenario: Get the current active space
- **GIVEN** a currentSpaceId is set in spaces data
- **WHEN** a GET request is sent to /api/spaces/current
- **THEN** the server SHALL return { currentSpaceId, space } with the matching space object
- **AND** if the currentSpaceId does not match any space, the first space SHALL be returned

#### Scenario: Create a new space with a name
- **GIVEN** a valid name is provided
- **WHEN** a POST request is sent to /api/spaces with { name }
- **THEN** the server SHALL create a space with a generated UUID, slug derived from the name, and empty settings
- **AND** the response SHALL return the created space with HTTP status 201

#### Scenario: Create space with optional logo and settings
- **GIVEN** a POST request includes name, logo, and settings fields
- **WHEN** the space is created
- **THEN** the logo and settings SHALL be stored on the space object

#### Scenario: Create space fails without a name
- **GIVEN** a POST request is missing the name field
- **WHEN** the request is sent to /api/spaces
- **THEN** the server SHALL return HTTP 400 with error "Name is required"

#### Scenario: Space slug is generated from the name
- **GIVEN** a space is being created with a name containing special characters or accents
- **WHEN** the slug is generated
- **THEN** the slug SHALL be lowercase, with accents removed, non-alphanumeric characters replaced by hyphens, and leading/trailing hyphens stripped

#### Scenario: Update a space by ID
- **GIVEN** a space exists with a known ID
- **WHEN** a PUT request is sent to /api/spaces/:id with updated fields
- **THEN** the name, slug, logo, and settings SHALL be updated as provided
- **AND** the response SHALL return the updated space object

#### Scenario: Update space fails for non-existent ID
- **GIVEN** no space exists with the specified ID
- **WHEN** a PUT request is sent to /api/spaces/:id
- **THEN** the server SHALL return HTTP 404 with error "Space not found"

#### Scenario: Switch the current active space
- **GIVEN** multiple spaces exist
- **WHEN** a PUT request is sent to /api/spaces/current with { spaceId }
- **THEN** the currentSpaceId SHALL be updated to the specified space
- **AND** the response SHALL include the updated currentSpaceId and the space object

#### Scenario: Switch space fails for non-existent spaceId
- **GIVEN** the provided spaceId does not match any existing space
- **WHEN** a PUT request is sent to /api/spaces/current
- **THEN** the server SHALL return HTTP 404 with error "Space not found"

#### Scenario: Switch space fails without spaceId
- **GIVEN** a PUT request to /api/spaces/current is missing the spaceId field
- **WHEN** the request is processed
- **THEN** the server SHALL return HTTP 400 with error "spaceId is required"

#### Scenario: Delete a space by ID
- **GIVEN** a space exists and there are at least 2 spaces total
- **WHEN** a DELETE request is sent to /api/spaces/:id
- **THEN** the space SHALL be removed from the spaces array
- **AND** if the deleted space was the current space, the currentSpaceId SHALL switch to the first remaining space

#### Scenario: Delete the last space is prevented
- **GIVEN** only one space exists
- **WHEN** a DELETE request is sent to /api/spaces/:id
- **THEN** the server SHALL return HTTP 400 with error "Cannot delete the last space"

#### Scenario: List members of a space
- **GIVEN** a space exists with members
- **WHEN** a GET request is sent to /api/spaces/:id/members
- **THEN** the server SHALL return the members array of the space
- **AND** each member SHALL include id, name, role, invitedAt, status, and optionally joinedAt

#### Scenario: List members fails for non-existent space
- **GIVEN** no space exists with the specified ID
- **WHEN** a GET request is sent to /api/spaces/:id/members
- **THEN** the server SHALL return HTTP 404 with error "Space not found"

#### Scenario: Create an invite code for a space
- **GIVEN** a space exists with a known ID
- **WHEN** a POST request is sent to /api/spaces/:id/invites
- **THEN** the server SHALL create an invite with a short random code (8 characters)
- **AND** the invite SHALL include createdBy, createdAt, and optional expiresAt and maxUses fields
- **AND** the response SHALL return the invite with HTTP status 201

#### Scenario: Create invite fails for non-existent space
- **GIVEN** no space exists with the specified ID
- **WHEN** a POST request is sent to /api/spaces/:id/invites
- **THEN** the server SHALL return HTTP 404 with error "Space not found"

#### Scenario: Revoke an invite code
- **GIVEN** a space exists with an active invite code
- **WHEN** a DELETE request is sent to /api/spaces/:id/invites/:code
- **THEN** the invite SHALL be removed from the space's invites array
- **AND** the response SHALL return { success: true }

#### Scenario: Revoke invite fails for non-existent space
- **GIVEN** no space exists with the specified ID
- **WHEN** a DELETE request is sent to /api/spaces/:id/invites/:code
- **THEN** the server SHALL return HTTP 404 with error "Space not found"

#### Scenario: Space data model includes all expected fields
- **GIVEN** a space is created and retrieved
- **WHEN** the space object is returned in any API response
- **THEN** it SHALL include id, name, slug, createdAt, settings (with optional defaultModel and theme), members array, and invites array

#### Scenario: Spaces persist to a JSON file on disk
- **GIVEN** any create, update, delete, switch, invite, or revoke operation is performed
- **WHEN** the operation completes
- **THEN** the entire spaces data SHALL be written to the spaces.json file in the base directory

#### Scenario: Space settings support theme and default model
- **GIVEN** a space has settings configured
- **WHEN** the space settings are updated via PUT /api/spaces/:id
- **THEN** the settings SHALL merge with existing settings
- **AND** the settings object SHALL support optional defaultModel and theme ('light', 'dark', 'system') fields
