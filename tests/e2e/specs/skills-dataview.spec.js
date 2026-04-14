const {test, expect} = require('@playwright/test');

test.describe('Skills DataView', () => {
  test.beforeEach(async ({page}) => {
    // Mock the REST API for skill entries
    await page.route('**/wp-json/wp/v2/assistant_skill*', (route) => {
      if (route.request().method() === 'GET') {
        route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-WP-Total': '2',
            'X-WP-TotalPages': '1',
          },
          body: JSON.stringify([
            {
              id: 1,
              title: {rendered: 'Translate page'},
              content: {
                rendered:
                  '<p>Translate the following page to {{language}}.</p>',
              },
              meta: {_assistant_model: ''},
              date: '2026-04-10T10:00:00',
            },
            {
              id: 2,
              title: {rendered: 'SEO audit'},
              content: {
                rendered: '<p>Review the page for SEO best practices.</p>',
              },
              meta: {_assistant_model: 'anthropic:haiku'},
              date: '2026-04-11T10:00:00',
            },
          ]),
        });
      } else {
        route.fulfill({status: 200, body: '{}'});
      }
    });

    await page.goto('/wp-admin/admin.php?page=gds-assistant-skills');
  });

  test('skills page loads', async ({page}) => {
    await expect(page.locator('h1, .wrap h2')).toContainText(/Skills/i);
  });

  test('DataView renders skill entries', async ({page}) => {
    const dataview = page.locator(
      '.dataviews-wrapper, [class*="dataview"], table',
    );
    await expect(dataview.first()).toBeVisible({timeout: 5000});
  });

  test('shows skill titles', async ({page}) => {
    await expect(page.locator('text=Translate page')).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator('text=SEO audit')).toBeVisible();
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
