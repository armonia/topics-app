// Dev convenience (macOS only): rename the unpacked Electron.app to "Topics DEV"
// and give it the app icon so `npm start` shows a branded dock entry.
// No-op on Windows/Linux and in CI — guarded so it never breaks installs there.
// Uses execFileSync (no shell) with a static argv — no injection surface.
import { execFileSync } from 'node:child_process';

if (process.platform === 'darwin') {
  const appDir = 'node_modules/electron/dist/Electron.app';
  const plist = `${appDir}/Contents/Info.plist`;
  const run = (file, args) => {
    try { execFileSync(file, args, { stdio: 'ignore' }); } catch { /* best effort */ }
  };
  run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleName Topics DEV', plist]);
  run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleDisplayName Topics DEV', plist]);
  run('cp', ['icon.icns', `${appDir}/Contents/Resources/electron.icns`]);
  run('touch', [appDir]);
}
