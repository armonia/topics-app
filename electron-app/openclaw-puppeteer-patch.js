/**
 * OpenClaw Puppeteer Patch
 * 
 * This patch modifies OpenClaw to use Puppeteer instead of Playwright
 * for connecting to external CDP endpoints (like Electron apps).
 * 
 * Run after each OpenClaw update: node openclaw-puppeteer-patch.js
 */

const fs = require('fs');
const path = require('path');

const OPENCLAW_DIST = process.env.OPENCLAW_DIST || path.join(process.env.HOME || require('os').homedir(), '.bun/install/global/node_modules/openclaw/dist');
const TARGET_FILE = path.join(OPENCLAW_DIST, 'pw-ai-BEqPnalN.js');
const BACKUP_FILE = path.join(OPENCLAW_DIST, 'pw-ai-BEqPnalN.js.backup');

// Puppeteer wrapper that exposes Playwright-like API
const PUPPETEER_WRAPPER = `
// === OPENCLAW PUPPETEER PATCH START ===
import puppeteerCore from 'puppeteer-core';

let puppeteerBrowser = null;
let puppeteerConnecting = null;

// Wrapper to make Puppeteer look like Playwright
class PuppeteerPlaywrightWrapper {
  constructor(browser, cdpUrl) {
    this._browser = browser;
    this._cdpUrl = cdpUrl;
    this._contexts = [new PuppeteerContextWrapper(browser)];
  }
  
  contexts() {
    return this._contexts;
  }
  
  on(event, handler) {
    if (event === 'disconnected') {
      this._browser.on('disconnected', handler);
    }
  }
  
  async close() {
    this._browser.disconnect();
  }
}

class PuppeteerContextWrapper {
  constructor(browser) {
    this._browser = browser;
    this._pages = null;
  }
  
  pages() {
    return this._pages || [];
  }
  
  async _loadPages() {
    const rawPages = await this._browser.pages();
    this._pages = rawPages.map(p => new PuppeteerPageWrapper(p));
    return this._pages;
  }
  
  async newPage() {
    const page = await this._browser.newPage();
    const wrapped = new PuppeteerPageWrapper(page);
    if (!this._pages) this._pages = [];
    this._pages.push(wrapped);
    return wrapped;
  }
}

class PuppeteerPageWrapper {
  constructor(page) {
    this._page = page;
    this._targetId = null;
  }
  
  url() {
    return this._page.url();
  }
  
  async title() {
    return await this._page.title();
  }
  
  async goto(url, opts) {
    await this._page.goto(url, { 
      timeout: opts?.timeout || 30000,
      waitUntil: 'domcontentloaded'
    });
  }
  
  async setViewportSize(size) {
    await this._page.setViewport(size);
  }
  
  async close() {
    await this._page.close();
  }
  
  async screenshot(opts) {
    return await this._page.screenshot({
      type: opts?.type || 'png',
      fullPage: opts?.fullPage || false
    });
  }
  
  async pdf(opts) {
    return await this._page.pdf({ printBackground: true });
  }
  
  async evaluate(fn, ...args) {
    return await this._page.evaluate(fn, ...args);
  }
  
  context() {
    return { newCDPSession: async (page) => await page._page.createCDPSession() };
  }
  
  // For getting target ID
  async _getTargetId() {
    if (this._targetId) return this._targetId;
    const target = this._page.target();
    this._targetId = target._targetId;
    return this._targetId;
  }
}

async function connectBrowserPuppeteer(cdpUrl) {
  const normalized = normalizeCdpUrl(cdpUrl);
  
  // Check if this is an external CDP (not OpenClaw's own browser)
  const isExternal = !normalized.includes(':18800') && !normalized.includes(':18801');
  
  if (!isExternal) {
    // Use original Playwright for OpenClaw's own browser
    return await connectBrowserPlaywrightOriginal(cdpUrl);
  }
  
  // Use Puppeteer for external CDP
  if (puppeteerBrowser?.cdpUrl === normalized) return puppeteerBrowser;
  if (puppeteerConnecting) return await puppeteerConnecting;
  
  const connectWithRetry = async () => {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const browser = await puppeteerCore.connect({
          browserURL: normalized,
          defaultViewport: null
        });
        
        const wrapper = new PuppeteerPlaywrightWrapper(browser, normalized);
        // Load pages
        await wrapper._contexts[0]._loadPages();
        
        puppeteerBrowser = { browser: wrapper, cdpUrl: normalized };
        
        browser.on('disconnected', () => {
          if (puppeteerBrowser?.browser._browser === browser) {
            puppeteerBrowser = null;
          }
        });
        
        return puppeteerBrowser;
      } catch (err) {
        lastErr = err;
        await new Promise(r => setTimeout(r, 500));
      }
    }
    throw lastErr || new Error('Puppeteer CDP connect failed');
  };
  
  puppeteerConnecting = connectWithRetry().finally(() => {
    puppeteerConnecting = null;
  });
  
  return await puppeteerConnecting;
}

// Store original function reference
const connectBrowserPlaywrightOriginal = connectBrowser;

// Override connectBrowser
connectBrowser = connectBrowserPuppeteer;
// === OPENCLAW PUPPETEER PATCH END ===
`;

function applyPatch() {
  console.log('OpenClaw Puppeteer Patch');
  console.log('========================\n');
  
  // Check if file exists
  if (!fs.existsSync(TARGET_FILE)) {
    console.error('ERROR: Target file not found:', TARGET_FILE);
    process.exit(1);
  }
  
  // Read the file
  let content = fs.readFileSync(TARGET_FILE, 'utf8');
  
  // Check if already patched
  if (content.includes('OPENCLAW PUPPETEER PATCH')) {
    console.log('Already patched! Skipping.');
    return;
  }
  
  // Backup original
  if (!fs.existsSync(BACKUP_FILE)) {
    fs.copyFileSync(TARGET_FILE, BACKUP_FILE);
    console.log('Created backup:', BACKUP_FILE);
  }
  
  // Find the position after imports (after the first //#region)
  const regionMatch = content.match(/\/\/#region src\/browser\/pw-session\.ts/);
  if (!regionMatch) {
    console.error('ERROR: Could not find insertion point');
    process.exit(1);
  }
  
  const insertPos = content.indexOf(regionMatch[0]);
  
  // Insert the patch
  content = content.slice(0, insertPos) + PUPPETEER_WRAPPER + '\n' + content.slice(insertPos);
  
  // Write patched file
  fs.writeFileSync(TARGET_FILE, content);
  console.log('Patch applied successfully!');
  console.log('\nRestart the OpenClaw gateway to activate.');
}

function removePatch() {
  if (fs.existsSync(BACKUP_FILE)) {
    fs.copyFileSync(BACKUP_FILE, TARGET_FILE);
    console.log('Patch removed, original restored.');
  } else {
    console.log('No backup found.');
  }
}

// Run
const arg = process.argv[2];
if (arg === '--remove') {
  removePatch();
} else {
  applyPatch();
}
