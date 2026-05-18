Feature: Master Topic created via CLI

  Background:
    Given the user is logged into Topics App at http://localhost:3333
    And the claude CLI is installed and authenticated

  @actor:developer @page:master_:id @spec:MASTER-01
  Scenario: User opens Master Topic via CLI command
    Given a registered project folder at /tmp/demo-repo
    When the user runs "topics master --project /tmp/demo-repo"
    Then Topics opens in the default browser at the master route
    And a Master Topic pane is visible with an active claude session
    And the spawned process has CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 in its environment
    And the topic has agent_team_role equal to "lead"

  @actor:developer @page:master_:id @spec:MASTER-01
  Scenario: Re-running the master command resumes the existing Master Topic
    Given a Master Topic already exists for "/tmp/demo-repo"
    When the user runs "topics master --project /tmp/demo-repo" again
    Then Topics focuses the existing Master Topic
    And no duplicate Master Topic is created
    And the previous claude session is resumed via "--resume"

  @actor:developer @page:master_:id @spec:MASTER-01
  Scenario: Master Topic UI shows the team-mode badge
    Given a Master Topic is open
    When the pane header renders
    Then a "Team Mode" badge is visible next to the topic title
    And the shared task list sidebar is visible
