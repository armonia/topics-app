# Tasks — dancerooms-org-onboarding

- [x] 1. `scopeProjectsToOrg(projects, orgId)` in `orgProjects.ts`: a project
      belongs to a group's page only if its own `orgId` matches; `null` orgId
      (personal) or no group selected never matches. Unit test.
- [x] 2. `IdentitySection` reports the selected group id upward
      (`onOrgChange`); `OrganizationPage` holds it and passes it to
      `OrgProjectsSection`.
- [x] 3. `OrgProjectsSection` renders `ShareControl` per project row.
- [x] 4. Short in-UI guide (two axes: share a link vs. run agents on a second
      machine) on the Organization page, en/it.
- [x] 5. Gates: typecheck, lint, identifier-language, emdash, comment-language,
      ui-language, deadcode green on the touched files.
- [ ] 6. Live verification with Simone's own account/device stays a separate,
      later step — it cannot happen inside this task (see task thread).
