# Change: dancerooms-org-onboarding

## Why

The Organization page (`OrgProjectsSection.tsx`) had no `orgId` at all: it
fetched `/api/projects` and rendered every non-incognito row, full stop. On an
installation with one group that bug is invisible — everything visible IS
that one group's projects. The day a second group exists on the same
installation (this card's live case: `Danceroom` and `Armonia`, one Topics
machine), it stops being correct: a personal project and Armonia's own
project both showed up on Danceroom's page too, because nothing told the
panel which page was open.

Separately, a project can never carry an `orgId` other than `null` or the
installation's own group (`PROJECT-13`, already landed). That is not a bug —
"one installation names exactly one group" is the approved contract from the
prior task — but it means the org page's project list will correctly stay
EMPTY for any group that is not the installation's own, and nothing on that
page explained why, or what to do about it: two different questions (who owns
a project vs. who can collaborate on it) read as one broken list.

## What changes

- `OrgProjectsSection` takes the selected group id as a prop and scopes the
  list to it (`orgId: null` or a personal project never belongs to any
  group's page). `IdentitySection` — the only place that already knows which
  group is picked — reports the change upward; `OrganizationPage` holds the
  state and threads it to both.
- Each project row on the org page gets the same `ShareControl` the sidebar
  already offers: a grant (person, device, or another group) and, once the
  relay is up, a remote link. This is the existing sharing mechanism
  (`sharing-orgs`), just reachable from the page a person actually opens to
  ask "who can get at our work" — it does not change what a grant does.
- A short, static guide on the same page names the two axes the brief asks
  for in plain terms: sharing a project (a link/grant, works from any
  browser, no install) vs. running agents on it (a second Topics
  installation, owned by the other person, with its own repository
  checkout). No new mechanism — it is the two things `sharing-orgs` and
  device pairing (`DevicesSection`/`PairingApproval`) already do, named where
  someone can find them.

## Out of scope

- Reassigning a project's `orgId` across groups: forbidden by `PROJECT-13`,
  not reopened here.
- A server-side change that makes a project appear in `/api/projects` for a
  person who only holds a grant on it (today a project-level grant only
  expands the *tasks* inside it — `server/lib/grants.ts`, `20260816230500`
  doc comment). Every device that is not the installation owner is a
  `guest` device (`devices.role`), and a guest never reaches `/api/projects`
  at all (`isGuestAllowedPath`) — so this is not the missing piece for a real
  collaborator; a second Topics installation, owned by them, is.
- Google OAuth as a login shortcut: the account service is
  `configured:false` today: building UI for it now would promise a feature
  that is not there. Left as a follow-up decision (see task thread).

## Impact

- `client/src/components/Settings/OrgProjectsSection.tsx`,
  `orgProjects.ts` (new, pure scoping function), `IdentitySection.tsx`,
  `IdentityPages.tsx`.
- `client/src/lib/i18n-en.ts`, `i18n-it.ts`: new guide copy.
- No server or schema change; no migration.
