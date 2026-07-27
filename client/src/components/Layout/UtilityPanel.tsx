// Id helpers moved to their canonical PURE home (state/pane/adapters/
// utilityPanelId.ts) so non-component modules (buildSidebarItems) can parse
// utility ids without importing this component. Re-exported here so existing
// importers keep working unchanged.
//
// The JSX `UtilityPanel` component that used to live in this file is gone:
// StandaloneChatGroup.tsx inlines the same per-type rendering itself (and has
// since grown a 'journal' branch this component never had), so the component
// here was never actually mounted anywhere — dead since that inlining landed.
// (No react-refresh/only-export-components suppression needed: with the
// component gone this file exports nothing but pure functions, so the rule
// never fires — the directive it used to carry was itself dead.)
export { isUtilityPanelId, utilityPanelId, parseUtilityPanelType } from '../../state/pane/adapters/utilityPanelId';
