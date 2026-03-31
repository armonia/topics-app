## ADDED Requirements

### Requirement: AGENT-03 — Profile Editor

The system SHALL provide a modal form for creating new agent profiles and editing existing ones, with fields for name, avatar emoji, role, model preference, max concurrent tasks, and capabilities, including validation that prevents saving without a name.

#### Scenario: Create profile modal opens with empty fields
- **GIVEN** the user is on the Roster tab
- **WHEN** the user clicks the create agent button
- **THEN** a modal opens with the heading "Create Agent Profile"
- **AND** the name field is empty
- **AND** the role defaults to "Worker"
- **AND** the avatar defaults to the first emoji option
- **AND** the submit button label reads "Create"

#### Scenario: Edit profile modal opens with pre-filled fields
- **GIVEN** the user is on the Roster tab viewing an existing agent profile
- **WHEN** the user clicks the "Edit" button on the profile card
- **THEN** a modal opens with the heading "Edit Agent Profile"
- **AND** the name field contains the current profile name
- **AND** the role selection reflects the current role
- **AND** the avatar shows the current emoji
- **AND** the submit button label reads "Save"

#### Scenario: Avatar emoji selection updates the chosen avatar
- **GIVEN** the profile editor modal is open
- **WHEN** the user clicks a different emoji in the avatar grid
- **THEN** the clicked emoji receives primary ring styling indicating selection
- **AND** the previously selected emoji loses the ring styling

#### Scenario: Role selector toggles between Lead, Worker, and Specialist
- **GIVEN** the profile editor modal is open
- **WHEN** the user clicks the "Lead" role button
- **THEN** the Lead button shows active primary styling
- **AND** the previously selected role button returns to default styling

#### Scenario: Empty name prevents form submission
- **GIVEN** the profile editor modal is open
- **WHEN** the name field is empty or contains only whitespace
- **THEN** the submit button is disabled with reduced opacity
- **AND** clicking the button has no effect

#### Scenario: Saving a new profile calls the create API
- **GIVEN** the "Create Agent Profile" modal is open
- **WHEN** the user fills in the name and clicks "Create"
- **THEN** the button text changes to "Saving..." during the request
- **AND** the agentProfilesApi.create method is called with the form data
- **AND** the modal closes on success and the onSave callback is invoked

#### Scenario: Saving an edited profile calls the update API
- **GIVEN** the "Edit Agent Profile" modal is open for an existing profile
- **WHEN** the user modifies the name and clicks "Save"
- **THEN** the agentProfilesApi.update method is called with the profile ID and updated data
- **AND** the modal closes on success

#### Scenario: API error displays error message in modal
- **GIVEN** the profile editor modal is open
- **WHEN** the save request fails with an error
- **THEN** an error message appears in a red-styled banner inside the modal
- **AND** the submit button returns to its normal enabled state

#### Scenario: Cancel button closes modal without saving
- **GIVEN** the profile editor modal is open with unsaved changes
- **WHEN** the user clicks the "Cancel" button
- **THEN** the modal closes
- **AND** no API call is made

#### Scenario: Close X button dismisses the modal
- **GIVEN** the profile editor modal is open
- **WHEN** the user clicks the X button in the modal header
- **THEN** the modal closes without saving

#### Scenario: Capabilities field accepts comma-separated values
- **GIVEN** the profile editor modal is open
- **WHEN** the user types "coding, testing, research" in the capabilities field
- **THEN** the values are parsed as three separate capabilities on save
- **AND** empty segments between commas are ignored

#### Scenario: Max concurrent tasks accepts numeric input
- **GIVEN** the profile editor modal is open
- **WHEN** the user sets the max concurrent tasks field to 3
- **THEN** the value is stored as the integer 3
- **AND** the field enforces a minimum of 1 and maximum of 10

#### Scenario: Profile card displays name, status, role badge, and actions
- **GIVEN** an agent profile exists in the roster
- **WHEN** the profile card renders
- **THEN** the card shows the avatar emoji, profile name, and a colored status dot
- **AND** a role badge (Lead, Worker, or Specialist) is displayed below the name
- **AND** Edit, Assign, and Sessions action buttons appear in the card footer

#### Scenario: Profile card shows capabilities as tags
- **GIVEN** an agent profile has capabilities defined
- **WHEN** the profile card renders
- **THEN** each capability appears as a small tag below the role badge

#### Scenario: Profile card shows max tasks count
- **GIVEN** an agent profile has a max concurrent tasks setting
- **WHEN** the profile card renders
- **THEN** the text "Max tasks: N" appears in the footer area
