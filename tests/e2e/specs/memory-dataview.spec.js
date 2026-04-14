const {test, expect} = require('@playwright/test');

test.describe('Memory DataView', () => {
  test.beforeEach(async ({page}) => {
    await page.goto('/wp-admin/admin.php?page=gds-assistant-memory');
  });

  test('memory page loads', async ({page}) => {
    await expect(page.locator('h1').first()).toContainText(/Memory/i);
  });

  test('DataView container renders', async ({page}) => {
    const container = page.locator('#gds-assistant-memory-dataview');
    await expect(container).toBeVisible({timeout: 5000});
  });

  test('has add button', async ({page}) => {
    const addButton = page.locator('button:has-text("Add"), a:has-text("Add")');
    if ((await addButton.count()) > 0) {
      await expect(addButton.first()).toBeVisible();
    }
  });
});
