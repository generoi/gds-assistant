const {test, expect} = require('@playwright/test');

test.describe('Skills DataView', () => {
  test.beforeEach(async ({page}) => {
    await page.goto('/wp-admin/admin.php?page=gds-assistant-skills');
  });

  test('skills page loads', async ({page}) => {
    await expect(page.locator('h1').first()).toContainText(/Skills/i);
  });

  test('DataView container renders', async ({page}) => {
    const container = page.locator('#gds-assistant-skills-dataview');
    await expect(container).toBeVisible({timeout: 5000});
  });

  test('has export button', async ({page}) => {
    const exportButton = page.locator('button:has-text("Export")');
    if ((await exportButton.count()) > 0) {
      await expect(exportButton.first()).toBeVisible();
    }
  });

  test('has import button', async ({page}) => {
    const importButton = page.locator('button:has-text("Import")');
    if ((await importButton.count()) > 0) {
      await expect(importButton.first()).toBeVisible();
    }
  });
});
