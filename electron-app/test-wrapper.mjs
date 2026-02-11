import puppeteerCore from 'puppeteer-core';

function wrapPage(page) {
  return {
    _page: page,
    url: () => page.url(),
    title: () => page.title(),
    goto: async (url, opts) => { await page.goto(url, { timeout: opts?.timeout || 30000, waitUntil: 'domcontentloaded' }); },
  };
}

function wrapBrowser(browser, cdpUrl) {
  const pages = [];
  const ctx = {
    pages: () => pages,
  };
  return {
    browser,
    cdpUrl,
    contexts: () => [ctx],
    loadPages: async () => { const raw = await browser.pages(); pages.length = 0; raw.forEach(p => pages.push(wrapPage(p))); },
  };
}

console.log('Testing wrapper...');

const browser = await puppeteerCore.connect({ browserURL: 'http://127.0.0.1:19222', defaultViewport: null });
const wrapped = wrapBrowser(browser, 'http://127.0.0.1:19222');
await wrapped.loadPages();

console.log('Contexts:', wrapped.contexts().length);
console.log('Pages:', wrapped.contexts()[0].pages().length);

for (const page of wrapped.contexts()[0].pages()) {
  console.log(' - URL:', page.url());
  console.log(' - Title:', await page.title());
}

// Try navigate
const firstPage = wrapped.contexts()[0].pages()[0];
console.log('Navigating...');
await firstPage.goto('https://example.com');
console.log('New URL:', firstPage.url());

browser.disconnect();
console.log('Success!');
