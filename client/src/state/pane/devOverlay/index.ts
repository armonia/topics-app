// Dev-only barrel. Callers MUST import this module only inside an
// `import.meta.env.DEV` guard so Vite can tree-shake it from production
// bundles (PANE-05 strip contract enforced by scripts/assert-dev-overlay-stripped.sh).
export { MutationLogOverlay } from './MutationLogOverlay';
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
