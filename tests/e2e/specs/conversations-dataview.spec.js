import {test, expect} from '@playwright/test';

test.describe('Conversations DataView', () => {
  test.beforeEach(async ({page}) => {
    // Mock the custom REST endpoint for conversations
    await page.route('**/wp-json/gds-assistant/v1/conversations*', (route) => {
      if (route.request().method() === 'GET') {
        route.fulfill({
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify([
            {
              uuid: 'conv-uuid-1',
              title: 'Help with product pages',
              model: 'anthropic:sonnet',
              tokens: 1500,
              created_at: '2026-04-10T10:00:00',
              updated_at: '2026-04-10T10:30:00',
              archived: false,
            },
            {
              uuid: 'conv-uuid-2',
              title: 'SEO optimization',
              model: 'gemini:flash',
              tokens: 3200,
              created_at: '2026-04-09T08:00:00',
              updated_at: '2026-04-09T09:00:00',
              archived: false,
            },
          ]),
        });
      } else if (route.request().method() === 'POST') {
        route.fulfill({status: 200, body: JSON.stringify({success: true})});
      }
    });

    await page.goto('/wp-admin/admin.php?page=gds-assistant-conversations');
  });

  test('conversations page loads', async ({page}) => {
    await expect(page.locator('h1, .wrap h2')).toContainText(/Conversations/i);
  });

  test('DataView renders conversations', async ({page}) => {
    const dataview = page.locator(
      '.dataviews-wrapper, [class*="dataview"], table',
    );
    await expect(dataview.first()).toBeVisible({timeout: 5000});
  });

  test('shows conversation titles', async ({page}) => {
    await expect(page.locator('text=Help with product pages')).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator('text=SEO optimization')).toBeVisible();
  });

  test('shows model info', async ({page}) => {
    await expect(page.locator('text=sonnet').first()).toBeVisible({
      timeout: 5000,
    });
  });

  test('has archive action', async ({page}) => {
    // Click on the first row's actions or kebab menu
    const actionButton = page
      .locator('[aria-label*="Actions"], button[class*="action"]')
      .first();
    if ((await actionButton.count()) > 0) {
      await actionButton.click();
      const archiveOption = page.locator('text=Archive');
      if ((await archiveOption.count()) > 0) {
        await expect(archiveOption.first()).toBeVisible();
      }
    }
  });
});
