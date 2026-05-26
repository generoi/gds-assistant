const {test, expect} = require('@playwright/test');
const {TOOL_UNDO_RESPONSE} = require('../fixtures/mock-responses.js');

/**
 * Covers the tool-call-parts rendering + the per-tool Undo button.
 *
 * The `.gds-assistant__tool-call` assertion is meaningful: before tool calls
 * were rendered as real components, they were inline markdown text and this
 * element never existed — so this test guards that refactor too.
 */
test.describe('Chat tool calls + undo', () => {
  test.beforeEach(async ({page}) => {
    await page.route('**/gds-assistant/v1/chat', (route) => {
      route.fulfill({
        status: 200,
        headers: {'Content-Type': 'text/event-stream'},
        body: TOOL_UNDO_RESPONSE,
      });
    });
    await page.goto('/wp-admin/');
  });

  async function runCreate(page) {
    await page.click('.gds-assistant__trigger');
    await page.locator('.gds-assistant__input').fill('Create a draft page called Undo Test');
    await page.click('.gds-assistant__send');
  }

  test('tool calls render as a tool-call component', async ({page}) => {
    await runCreate(page);

    const toolCall = page.locator('.gds-assistant__tool-call').first();
    await expect(toolCall).toBeVisible({timeout: 5000});
    await expect(toolCall).toContainText('gds/content-create');
    await expect(
      toolCall.locator('.gds-assistant__tool-call-status--done'),
    ).toBeVisible();
  });

  test('a reversible action shows an Undo button that reverts it', async ({
    page,
  }) => {
    let undoBody = null;
    await page.route('**/gds-assistant/v1/undo', (route) => {
      undoBody = JSON.parse(route.request().postData() || '{}');
      route.fulfill({
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          undone: true,
          action: 'gds/content-create',
          caveats: [],
        }),
      });
    });

    await runCreate(page);

    const undoBtn = page.locator('.gds-assistant__tool-undo-btn');
    await expect(undoBtn).toBeVisible({timeout: 5000});

    await undoBtn.click();

    // Becomes "Undone", and the endpoint was called with the right audit id.
    await expect(
      page.locator('.gds-assistant__tool-call-status--undone'),
    ).toBeVisible({timeout: 5000});
    expect(undoBody?.id).toBe(555);
  });

  test('undo surfaces caveats when the restore is imperfect', async ({page}) => {
    await page.route('**/gds-assistant/v1/undo', (route) => {
      route.fulfill({
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          undone: true,
          caveats: ['The term was reinstated under a new id; check menu items.'],
        }),
      });
    });

    await runCreate(page);
    await page.locator('.gds-assistant__tool-undo-btn').click();

    await expect(
      page.locator('.gds-assistant__tool-undo-caveats'),
    ).toContainText('new id', {timeout: 5000});
  });
});
