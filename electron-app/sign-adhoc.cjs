// electron-builder `afterPack` hook — ad-hoc code-signing for macOS.
//
// Why: an unsigned .app has no stable identity (no Contents/_CodeSignature),
// so macOS TCC cannot persist the "would like to access Documents/Desktop…"
// grants and re-prompts on EVERY launch. electron-builder ships unsigned here
// because no Apple Developer ID is configured (mac.identity:null / empty
// CSC_*). An ad-hoc signature (`codesign --sign -`) gives the bundle a stable
// cdhash, so TCC remembers the grants between launches of the same build.
//
// Limits (vs. a real Developer ID + notarization): Gatekeeper still warns on
// first open, and the cdhash changes every release, so the grants are re-asked
// ONCE after each update. When real signing secrets are present (CSC_LINK /
// CSC_NAME) this hook steps aside and lets electron-builder sign properly.
//
// Ordering: runs after the app is packed (asar + Info.plist final, the
// ElectronAsarIntegrity hash already written), so signing the bundle as-is
// stays consistent — no asar repack / hash recompute needed.

const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

/** @param {import('electron-builder').AfterPackContext} context */
module.exports = async function adHocSignMac(context) {
  if (context.electronPlatformName !== 'darwin') return;

  // Defer to electron-builder's real signing when a Developer ID is configured.
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log('  • mac signing: Developer ID present — skipping ad-hoc hook');
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  if (!existsSync(appPath)) {
    console.warn(`  • ad-hoc sign skipped: ${appPath} not found`);
    return;
  }

  console.log(`  • ad-hoc signing ${appName} (no Developer ID set)…`);
  // `-` = ad-hoc identity; --deep covers the bundled Electron frameworks and
  // helpers; --timestamp=none since ad-hoc can't contact a timestamp server.
  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath],
    { stdio: 'inherit' },
  );
  console.log('  • ad-hoc signature applied — stable cdhash so TCC remembers grants');
};
