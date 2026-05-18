Feature: Teammate Topics are spawned by the Master

  Background:
    Given a Master Topic is active for project "/tmp/demo-repo"

  @actor:developer @page:master_:id @spec:MASTER-02
  Scenario: Lead delegation spawns a teammate Topic
    When the lead emits a delegation event for a sub-task in "/tmp/demo-repo"
    Then a new teammate Topic is created with parent_topic_id equal to the Master Topic id
    And the teammate agent_team_role is "teammate"
    And the teammate cwd matches the delegated project path
    And the teammate pane appears in the Master layout

  @actor:developer @page:topic_:id @spec:MASTER-02
  Scenario: Teammate pane displays the assigned task
    Given a teammate Topic has been assigned a task
    When the pane renders
    Then the task title is shown in the pane header
    And a status badge reflects the teammate's current activity

  @actor:developer @page:master_:id @spec:MASTER-03
  Scenario: Pro user spawning a fourth teammate sees a budget warning
    Given the user is on a Claude Pro plan
    And the user has 3 active teammate Topics under the Master
    When the lead attempts to spawn a fourth teammate
    Then a non-blocking warning banner appears in the Master pane
    And the warning mentions the weekly limit and upgrade path
    And the user can dismiss or proceed
