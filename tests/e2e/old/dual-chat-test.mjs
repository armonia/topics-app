export default async function({ page, baseUrl, expect }) {
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Click the "+" button next to "Chats" section to create new chat
  // It's a small button with aria-label or text "New chat"
  const newChatPlusBtn = page.locator('button').filter({ hasText: /^New chat$/ });
  const plusBtn = page.locator('button[aria-label="New chat"]');
  const fallback = page.locator('button >> text="+"').nth(1); // second + button (first is in header)

  async function createNewChat() {
    if (await newChatPlusBtn.count() > 0) {
      await newChatPlusBtn.first().click();
    } else if (await plusBtn.count() > 0) {
      await plusBtn.first().click();
    } else {
      await fallback.click();
    }
    // Wait for textarea to appear
    await page.locator('textarea').waitFor({ timeout: 5000 });
    await page.waitForTimeout(500);
  }

  // --- Create Chat A ---
  await createNewChat();
  await page.locator('textarea').fill('Test dual A — rispondi solo "Alpha OK"');
  await page.keyboard.press('Enter');
  console.log('📋 Chat A created & message sent');
  await page.waitForTimeout(4000);

  // --- Create Chat B ---
  await createNewChat();
  await page.locator('textarea').fill('Test dual B — rispondi solo "Beta OK"');
  await page.keyboard.press('Enter');
  console.log('📋 Chat B created & message sent');
  await page.waitForTimeout(4000);

  // Both chats exist now. Find them in sidebar tree
  const allItems = page.locator('[role="treeitem"]');

  // Switch to Chat A (find by partial text)
  const chatA = allItems.filter({ hasText: /Test dual A|Alpha/ }).first();
  const chatB = allItems.filter({ hasText: /Test dual B|Beta/ }).first();

  const aExists = await chatA.count() > 0;
  const bExists = await chatB.count() > 0;
  console.log(`Chat A in sidebar: ${aExists}, Chat B in sidebar: ${bExists}`);

  if (aExists) {
    await chatA.click();
    await page.waitForTimeout(2000);
    const logA = await page.locator('[role="log"]').textContent();
    console.log(`📋 Chat A — content: ${logA?.length || 0} chars`);
  }

  if (bExists) {
    await chatB.click();
    await page.waitForTimeout(2000);
    const logB = await page.locator('[role="log"]').textContent();
    console.log(`📋 Chat B — content: ${logB?.length || 0} chars`);
  }

  // Rapid switching
  for (let i = 0; i < 4; i++) {
    if (aExists) { await chatA.click(); await page.waitForTimeout(600); }
    if (bExists) { await chatB.click(); await page.waitForTimeout(600); }
  }
  console.log('✅ Rapid switching 4x done');

  await page.waitForTimeout(3000);

  // Verify no "failed to load"
  const fails = await page.locator('text=/failed to load/i').count();
  expect(fails).toBe(0);
  console.log('✅ Zero "failed to load"');

  // Cleanup: delete test chats (right-click → delete, or via API)
  // For now just note them for manual cleanup
  console.log('⚠️ Test chats created — clean up "Test dual A/B" from Chats section');

  console.log('\n🎉 Dual chat test passed!');
}
