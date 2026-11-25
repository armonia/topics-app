# Intersections gate, removed until spec-flow 0.7.0 is published

Re-add with the bump to `@armonia-io/spec-flow` 0.7.0 (package.json + bun.lock in the same commit) once 0.7.0 is on npm.

The CI step, verbatim from `.github/workflows/ci.yml` (it sat right after the `bun run lint:openspec` step in the gates job):

```yaml
          # spec-flow D19, "intrecci": every `**Intersects:**` line in `openspec/specs/` needs ONE
          # executed unit (one Playwright annotation, or one `@covers A+B`) that names both sides,
          # read from the `joint` key of the map `lint:openspec` just wrote. Run through npx like the
          # tree-verdict steps because the command exists from 0.7.0 on, and `package.json` still
          # pins 0.5.0: bumping it needs a published 0.7.0 and a refreshed `bun.lock` in the same
          # commit (a bare bump makes every `bun install --frozen-lockfile` fail). When that lands,
          # replace the pin with the `jq` read of package.json used by the tree-verdict steps.
          npx --yes "@armonia-io/spec-flow@0.7.0" check-intersections
```

The script, verbatim from `package.json` (`scripts`, right after `lint:openspec`):

```json
    "lint:intrecci": "bun run scripts/check-spec-coverage.ts --json openspec/coverage-map.json > /dev/null; spec-flow check-intersections",
```
