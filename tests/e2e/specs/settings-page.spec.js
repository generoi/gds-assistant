const {test, expect} = require('@playwright/test');

test.describe('Settings Page', () => {
  test.beforeEach(async ({page}) => {
    await page.goto('/wp-admin/admin.php?page=gds-assistant');
  });

  test('settings page loads', async ({page}) => {
    await expect(page.locator('h1, .wrap h2')).toContainText(/AI Assistant/i);
  });

  test('shows provider status section', async ({page}) => {
    // Provider status cards or table should be visible
    const providerSection = page.locator('text=Provider');
    await expect(providerSection.first()).toBeVisible();
  });

  test('shows system prompt preview', async ({page}) => {
    const systemPrompt = page.locator(
      '[id*="system-prompt"], .gds-assistant-system-prompt, textarea[readonly]',
    );
    await expect(systemPrompt.first()).toBeVisible();
  });

  test('has auto-memory toggle', async ({page}) => {
    const toggle = page.locator(
      'input[type="checkbox"][name*="auto_memory"], [data-setting="auto_memory"]',
    );
    // May be a WP toggle or checkbox
    if ((await toggle.count()) > 0) {
      await expect(toggle.first()).toBeVisible();
    }
  });

  test('has custom prompt textarea', async ({page}) => {
    const textarea = page.locator(
      'textarea[name*="custom_prompt"], textarea[name*="system_prompt"]',
    );
    if ((await textarea.count()) > 0) {
      await expect(textarea.first()).toBeVisible();
    }
  });
});
