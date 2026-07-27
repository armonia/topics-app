// Id helpers moved to their canonical PURE home (state/pane/adapters/
// utilityPanelId.ts) so non-component modules (buildSidebarItems) can parse
// utility ids without importing this component. Re-exported here so existing
// importers keep working unchanged.
//
// The JSX `UtilityPanel` component that used to live in this file is gone:
// StandaloneChatGroup.tsx inlines the same per-type rendering itself (and has
// since grown a 'journal' branch this component never had), so the component
// here was never actually mounted anywhere — dead since that inlining landed.
// eslint-disable-next-line react-refresh/only-export-components -- pure re-export for back-compat with existing importers
export { isUtilityPanelId, utilityPanelId, parseUtilityPanelType } from '../../state/pane/adapters/utilityPanelId';
