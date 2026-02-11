import puppeteer from 'puppeteer-core';

console.log('Testing Puppeteer...');

try {
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:19222',
  });
  
  console.log('Connected!');
  
  const pages = await browser.pages();
  console.log('Pages:', pages.length);
  
  for (const page of pages) {
    console.log(' - URL:', page.url());
    console.log(' - Title:', await page.title());
  }
  
  // Navigate one of the pages
  if (pages.length > 0) {
    await pages[0].goto('https://example.com');
    console.log('Navigated to:', pages[0].url());
  }
  
  // Don't close browser, just disconnect
  browser.disconnect();
  console.log('Success!');
} catch (e) {
  console.error('Error:', e.message);
}
