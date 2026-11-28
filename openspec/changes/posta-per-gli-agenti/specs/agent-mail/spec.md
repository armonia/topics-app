## ADDED Requirements

### Requirement: MAIL-01 — Declared mailboxes, one list to receive and send
Topics SHALL read the mailboxes from the app settings: name, own addresses, an adapter command with a JSON contract (`list` from a cursor, `read`, optionally `draft`), the trusted `authserv-id` and two switches ("agents may wait for mail here", "automatic rules here"). With no mailbox declared nothing runs and the tools say so.

#### Scenario: No mailbox declared
- **WHEN** the settings declare no mailbox
- **THEN** no adapter process is started and the mail tools answer that no mailbox exists

#### Scenario: Settings win over the environment
- **WHEN** the same mailbox is in the settings and in the environment variables
- **THEN** the settings are used

### Requirement: MAIL-02 — Reception from a cursor, in one transaction
The server SHALL read each enabled mailbox in a loop of its own, one at a time, and write the messages, the matched waits and the cursor in ONE transaction. An expired cursor re-reads the last window, never "from now". A message sent from one of the mailbox addresses is marked as own and triggers nothing.

#### Scenario: The same message twice
- **WHEN** the adapter returns a message already stored
- **THEN** one row exists for it

#### Scenario: A stop halfway through the transaction
- **WHEN** the server stops after writing the messages and before the cursor
- **THEN** nothing is written and the next round has no gap and no duplicate

### Requirement: MAIL-03 — A wait is a row
`wait_for_mail` SHALL write the owner, the mailbox, the criteria (always the sender) and the deadline (at most 30 days), and look among the messages already received in the same transaction. It is refused without a sender, without a deadline, on an unknown mailbox or with the switch off.

#### Scenario: The mail arrived before the wait
- **WHEN** the matching message is already stored when the wait is created
- **THEN** the wait is completed at creation

### Requirement: MAIL-04 — One wake, once
A match SHALL be a conditional update on an open wait; the sender must match the criteria AND pass the provider verification of the mailbox. The wake is written in the same transaction and delivered with the wait id as its key; it never carries the body.

#### Scenario: Two connections on one database
- **WHEN** two servers match the same message
- **THEN** one wake is delivered

#### Scenario: Unverified sender
- **WHEN** the sender matches but `dmarc` did not pass for the trusted `authserv-id`
- **THEN** nothing matches and the reason is written on the wait

### Requirement: MAIL-05 — The deadline is an outcome
A wait past its deadline SHALL become `expired` through the same conditional update and wake its owner, even with reception stopped.

#### Scenario: Reception stopped
- **WHEN** the deadline passes while no mailbox is being read
- **THEN** the wait is `expired` and the owner is woken once

### Requirement: MAIL-06 — The wait is visible
Card and chat SHALL show what mail is awaited, from which sender, on which mailbox, since when and until when, with a way to cancel it.

#### Scenario: Cancel from the card
- **WHEN** the person cancels the wait
- **THEN** the wait is closed and no wake is delivered

### Requirement: MAIL-07 — Reading without the shell
`read_mail` SHALL go through the adapter of an enabled mailbox and return the text inside a frame the text itself cannot close.

#### Scenario: A body that tries to close the frame
- **WHEN** the body contains the closing marker
- **THEN** the frame is computed on the text and stays closed around it

### Requirement: MAIL-08 — A mail leaves once, even across a restart
A mail SHALL be sent through the delivery register of the schedule engine (rule R23), with its states and its boot rule: a row found `delivering` at boot becomes `unknown`, is never sent again by itself, and the person is told. The key is born in the bridge at every `send_mail` call and travels with all its retries; it is not a digest of the content. The confirmation is a `pending` row that holds the message until its outcome: after a restart a "Conferma" on that question makes the server send from the row, once. `send_mail` returns the message id when the adapter gives one.

#### Scenario: Restart between the send and its record
- **WHEN** the server stops after the adapter started and before the outcome was written, and the bridge retries with the same key
- **THEN** the row is `unknown`, nothing is sent a second time and the card says the mail may have gone out

#### Scenario: Confirmation given after a restart
- **WHEN** the server restarts with the question open and the person answers "Conferma" on it
- **THEN** the server sends from the row once, and the bridge retrying the same key gets that outcome without a second send

#### Scenario: A lost answer
- **WHEN** the mail left and the HTTP answer was lost, and the bridge retries the same key
- **THEN** the bridge gets the recorded outcome and no second question is opened

#### Scenario: A failed send is final for its key
- **WHEN** the adapter exits non-zero
- **THEN** the row is `delivery_failed` and a retry of the same key starts nothing

#### Scenario: The same content asked twice
- **WHEN** an agent calls `send_mail` twice with the identical message
- **THEN** two questions are asked and, both confirmed, two mails leave

### Requirement: MAIL-09 — Declared automatic rules, never a send
Each mailbox SHALL have ordered rules whose actions are: alert the owner, create a card with a fixed text (mailbox, sender, message id; neither subject nor body, never started by itself), prepare a draft when the adapter can. No send action exists, and the actions of a rule on a mail happen once even with a stop halfway.

#### Scenario: A stop halfway through the actions
- **WHEN** the server stops after the first action of a rule
- **THEN** at restart the missing actions run once and the done ones do not
