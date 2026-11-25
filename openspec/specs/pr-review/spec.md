# pr-review Specification

## Purpose
Automatic review of pull requests, on a cheap model, run on the machine that hosts the server. No secret and no API key travel with it: it uses the local `gh` login and the local `claude` CLI.
## Requirements
### Requirement: PRREVIEW-01 — Opt-in, no burst, one review per pass, defects reach the board

The system SHALL review pull requests only when BOTH `REVIEW_PR_REPO` (an `owner/name`) and `REVIEW_PR_WORKFLOW` (the path of the review workflow file) are set; when either is empty it SHALL do nothing. No repository, user or project name SHALL be wired into the code.

On the first pass ever, the system SHALL record every PR open at that moment as already seen, together with its head commit, and SHALL review none of them. After that it SHALL review only a PR that is opened, or whose head commit changes, and it SHALL start at most ONE review per pass: the other pending PRs wait for the next pass. A review that fails SHALL be retried on later passes, and SHALL be given up after three failures so that it cannot block the others.

When a review confirms at least one defect, the system SHALL open a card in review on the board of the project whose `origin` is that repository, carrying a link to the PR and the defects. When it confirms none, it SHALL only leave the verdict file. It SHALL NOT post anything on GitHub.

#### Scenario: Switching on does not review the open PRs
- **GIVEN** two PRs are open and the feature has never run
- **WHEN** the first pass runs
- **THEN** both are recorded as seen and no review starts
- **AND** a later push to one of them, or a new PR, is reviewed

#### Scenario: Confirmed defects reach the board
- **GIVEN** a review that confirms one defect
- **WHEN** the pass ends
- **THEN** a card in review exists on the project that owns the repository, with the PR link and the defect
