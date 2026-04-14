const {test, expect} = require('@playwright/test');

test.describe('Conversations DataView', () => {
  test.beforeEach(async ({page}) => {
    await page.goto('/wp-admin/admin.php?page=gds-assistant-conversations');
  });

  test('conversations page loads', async ({page}) => {
    await expect(page.locator('h1').first()).toContainText(/Conversations/i);
  });

  test('DataView container renders', async ({page}) => {
    const container = page.locator('#gds-assistant-conversations-dataview');
    await expect(container).toBeVisible({timeout: 5000});
  });
});
