import { test, expect } from '@playwright/test';

test('Sidebar toggle — visual evidence', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  
  // BEFORE: sidebar open
  await page.screenshot({ path: 'test-results/sidebar-BEFORE-open.png', fullPage: false });
  
  // Toggle sidebar closed
  const toggleBtn = page.getByTitle('Toggle sidebar');
  if (await toggleBtn.count() > 0) {
    await toggleBtn.click();
    await page.waitForTimeout(1500);
    
    // AFTER: sidebar closed
    await page.screenshot({ path: 'test-results/sidebar-AFTER-closed.png', fullPage: false });
    
    // Toggle back open
    await toggleBtn.click();
    await page.waitForTimeout(1500);
    
    // AFTER: sidebar reopened
    await page.screenshot({ path: 'test-results/sidebar-AFTER-reopened.png', fullPage: false });
  }
});

test('Topic switch — visual evidence', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  
  const topics = page.getByRole('treeitem');
  if (await topics.count() > 1) {
    // Click first topic
    await topics.first().click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'test-results/topic-BEFORE-switch.png', fullPage: false });
    
    // Switch to second topic
    await topics.nth(1).click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'test-results/topic-AFTER-switch.png', fullPage: false });
  }
});

test('Page load — visual evidence', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/load-500ms.png', fullPage: false });
  
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/load-2000ms.png', fullPage: false });
  
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'test-results/load-4000ms.png', fullPage: false });
});
