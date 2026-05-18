Feature: Jump from board task card to teammate pane

  Background:
    Given a Master Topic exists with teammates working on tasks
    And the kanban board is visible

  @actor:developer @page:board @spec:KANBAN-DELTA-01
  Scenario: Click on assignment badge focuses teammate pane
    Given a task card has an assigned teammate Topic badge
    When the user clicks the badge
    Then the layout focuses the teammate Topic pane
    And the pane scrolls to the latest output

  @actor:developer @page:board @spec:KANBAN-DELTA-01
  Scenario: Keyboard shortcut cycles through teammate panes
    Given the board is focused
    And there are 3 teammate Topics under the active Master
    When the user presses Cmd+J
    Then the focus advances to the next teammate pane
    And the topic title in the address bar reflects the focused teammate
