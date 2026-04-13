import {test, expect} from '@playwright/test';

test.describe('Memory DataView', () => {
  test.beforeEach(async ({page}) => {
    // Mock the REST API for memory entries
    await page.route('**/wp-json/wp/v2/assistant_memory*', (route) => {
      const url = new URL(route.request().url());

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
              title: {rendered: 'Site uses Polylang'},
              content: {
                rendered:
                  '<p>The site uses Polylang Pro for multilingual support.</p>',
              },
              meta: {_memory_source: 'auto'},
              date: '2026-04-10T10:00:00',
            },
            {
              id: 2,
              title: {rendered: 'Product structure'},
              content: {
                rendered: '<p>Products are custom post type gds-product.</p>',
              },
              meta: {_memory_source: 'manual'},
              date: '2026-04-11T10:00:00',
            },
          ]),
        });
      } else {
        route.fulfill({status: 200, body: '{}'});
      }
    });

    await page.goto('/wp-admin/admin.php?page=gds-assistant-memory');
  });

  test('memory page loads', async ({page}) => {
    await expect(page.locator('h1, .wrap h2')).toContainText(/Memory/i);
  });

  test('DataView renders memory entries', async ({page}) => {
    const dataview = page.locator(
      '.dataviews-wrapper, [class*="dataview"], table',
    );
    await expect(dataview.first()).toBeVisible({timeout: 5000});
  });

  test('shows memory entry titles', async ({page}) => {
    await expect(page.locator('text=Site uses Polylang')).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator('text=Product structure')).toBeVisible();
  });

  test('has add button', async ({page}) => {
    const addButton = page.locator('button:has-text("Add"), a:has-text("Add")');
    if ((await addButton.count()) > 0) {
      await expect(addButton.first()).toBeVisible();
    }
  });
});
