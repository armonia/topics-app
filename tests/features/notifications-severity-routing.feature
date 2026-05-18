Feature: Severity-routed notifications

  Background:
    Given the user is logged into Topics App
    And the tray app is running and connected

  @actor:developer @page:tray @spec:NOTIF-02
  Scenario: P0 event triggers sound, desktop, and iOS push
    Given a teammate session crashes
    When the event is classified as P0
    Then a desktop notification is shown with sound
    And an iOS push is dispatched via the existing web-push channel
    And the tray badge shows the red blocker indicator

  @actor:developer @page:tray @spec:NOTIF-02
  Scenario: P1 event triggers silent desktop notif and badge
    Given a teammate completes a task awaiting review
    When the event is classified as P1
    Then a silent desktop notification is shown
    And the tray badge count increments
    And no iOS push is sent

  @actor:developer @page:tray @spec:NOTIF-02
  Scenario: P2 event updates badge only
    Given a teammate transitions to idle without completing a task
    When the event is classified as P2
    Then the tray badge is refreshed
    And no desktop notification is shown

  @actor:developer @page:tray @spec:NOTIF-03
  Scenario: Focus mode suppresses P1 but always delivers P0
    Given macOS Focus mode is active
    When a P1 event is emitted
    Then the desktop notification is suppressed
    And the badge still increments
    When a P0 event is emitted
    Then the desktop notification is shown with sound

  @actor:developer @page:topic_:id @spec:NOTIF-04
  Scenario: Click on awaiting-review notification jumps to teammate pane
    Given a P1 notification for a task awaiting review is visible
    When the user clicks the notification
    Then Topics window comes to front
    And the pane hosting the teammate Topic is focused
    And the task detail panel opens with the reasoning trail visible
