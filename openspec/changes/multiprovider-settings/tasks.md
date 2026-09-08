# Implementation and evidence

- [x] Add first-installation API setup, private persistence, validation, and key replacement.
- [x] Preserve explicit provider/model selection and apply API defaults on the next turn.
- [x] Repair OpenAI completion limits, catalog/probe caching, and streaming failure handling.
- [x] Route coding tasks only through available coding agents and preserve their workspace/session.
- [x] Bound native credential refresh and respect lock ownership.
- [x] Simplify desktop/mobile Settings and keep advanced controls unmounted until opened.
- [x] Evaluate native execution across providers and document the remaining product boundary.
- [x] Restore the existing initial-download budget without increasing its baseline.
- [x] Review routing and credential configuration independently.
- [x] Finish the final file-access regression, static gates, and browser evidence after the last changes.

Local rollout follows the verified commit: restart when active work permits, then publish the matching client bundle. The new client must not precede the credential-validation backend.

See `assessment.md` for the capability assessment and reproducible evidence.
