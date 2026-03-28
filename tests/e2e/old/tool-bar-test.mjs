export default async function({ page, baseUrl }) {
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');

  // Expand tida and open a chat
  await page.click('button:has-text("tida")');
  await page.waitForTimeout(800);
  await page.click('button:has-text("tida")');
  await page.waitForTimeout(1000);

  // Click first available chat under tida
  const chats = page.locator('[role="treeitem"]').filter({ hasText: /CSS Framework|Test screenshot/ });
  await chats.first().click();
  await page.waitForTimeout(2000);
  
  // Type a message that triggers browser tool
  const textarea = page.locator('textarea');
  await textarea.click();
  await textarea.type('Apri un browser su example.com, fai uno screenshot e dimmi cosa vedi');
  
  // Send
  await page.keyboard.press('Enter');

  // Capture every 2 seconds for 40 seconds to catch tool bar
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(2000);
    // Check if SubAgentBar appeared
    const bar = await page.locator('text=/tool|agent.*running|Browser|Searching/i').count();
    if (bar > 0) {
      console.log(`✅ Tool bar detected at ${i*2}s!`);
    }
  }
}
