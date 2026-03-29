export default async function({ page, baseUrl, expect }) {
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Create new chat
  const newChatBtn = page.locator('button[aria-label="New chat"], button:has-text("New chat")');
  await newChatBtn.first().click();
  await page.waitForTimeout(2000);

  // Find and use the textarea
  const textarea = page.locator('textarea');
  await textarea.waitFor({ timeout: 10000 });
  await textarea.fill('Cerca su internet "best pizza Rome 2026" e dimmi il primo risultato');
  await page.keyboard.press('Enter');
  console.log('📋 Message sent');

  let responseReceived = false;
  let foundTool = false;

  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(2000);

    // Check for error/warning
    const warnings = await page.locator('text=/⚠️/').count();
    if (warnings > 0) {
      console.log(`⚠️ Error at ${i*2}s`);
      break;
    }

    // Check for tool badges
    const allText = await page.locator('[class*="font-mono"]').allTextContents();
    const tools = allText.filter(t => /web_search|web_fetch|browser|exec/.test(t));
    if (tools.length > 0 && !foundTool) {
      console.log(`🔧 Tool badge at ${i*2}s: ${tools.join(', ')}`);
      foundTool = true;
    }

    // Check for response content
    const msgs = page.locator('.message-content');
    const count = await msgs.count();
    if (count >= 2) {
      const lastText = await msgs.last().textContent();
      const streaming = await page.locator('.animate-bounce').count();
      if (lastText && lastText.length > 50 && streaming === 0) {
        console.log(`✅ Response received: ${lastText.length} chars`);
        responseReceived = true;
        break;
      }
    }
  }

  expect(responseReceived).toBeTruthy();
  
  if (foundTool) {
    console.log('\n🎉 WS chat + inline tool calls WORKING!');
  } else {
    console.log('\n✅ WS chat works (model may not have used tools)');
  }
}
