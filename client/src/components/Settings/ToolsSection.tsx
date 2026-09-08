import { McpFleetPanel } from './McpFleetPanel';
import { PermissionsSection } from './PermissionsSection';

/** Tool connections and persistent grants share their own settings page. */
export function ToolsSection() {
  return (
    <div data-testid="settings-tools" className="space-y-6">
      <McpFleetPanel />
      <div className="border-t border-app-border pt-5">
        <PermissionsSection />
      </div>
    </div>
  );
}
