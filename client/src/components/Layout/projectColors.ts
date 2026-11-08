// Pure project-identity helpers (color hashing + name extraction).
// Kept in a non-component module so Fast Refresh stays happy for the
// component files that consume them (StandaloneChatGroup).

// Generate a color from a string (project path → HSL)
export function hashToColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
    hash = hash & hash; // Convert to 32bit integer
  }
  // Use hue from hash, fixed saturation/lightness for good contrast
  const hue = Math.abs(hash % 360);
  return `hsl(${hue}, 65%, 50%)`;
}

// Helper to extract project name from path
export function getProjectName(projectPath: string): string {
  const parts = projectPath.split('/').filter(Boolean);
  return parts[parts.length - 1] || projectPath;
}
