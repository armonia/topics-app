// Loader for the per-region vibrancy native addon. Fails SOFT: on any platform
// other than macOS, or if the .node binary isn't built / can't load, every
// method is a no-op so the app keeps running on its whole-window/CSS fallback.
'use strict';

let addon = null;
try {
  if (process.platform === 'darwin') {
    // Resolve the built binary relative to this file (build/Release/vibrancy.node).
    addon = require('bindings')({
      bindings: 'vibrancy',
      module_root: __dirname,
    });
  }
} catch (err) {
  addon = null;
  if (process.env.VIBRANCY_DEBUG) console.error('[vibrancy] addon load failed:', err && err.message);
}

module.exports = {
  available: !!addon,
  /**
   * Place/upsert frosted vibrancy regions under the given window.
   * @param {Buffer} handle  win.getNativeWindowHandle()
   * @param {Array<{x:number,y:number,w:number,h:number,radius?:number}>} rects
   * @param {string} [material] 'sidebar' | 'underWindow' | 'popover' | 'hudWindow' | 'menu' | 'fullScreenUI'
   * @returns {number} number of regions applied
   */
  setRegions(handle, rects, material) {
    if (!addon || !handle) return 0;
    try { return addon.setRegions(handle, rects || [], material || 'sidebar'); }
    catch (err) { if (process.env.VIBRANCY_DEBUG) console.error('[vibrancy] setRegions:', err); return 0; }
  },
  /** Remove all managed vibrancy regions from the window. */
  clear(handle) {
    if (!addon || !handle) return;
    try { addon.clear(handle); }
    catch (err) { if (process.env.VIBRANCY_DEBUG) console.error('[vibrancy] clear:', err); }
  },
};
