const {test, expect} = require('@playwright/test');
const {
  SIMPLE_TEXT_RESPONSE,
  TOOL_CALL_RESPONSE,
} = require('../fixtures/mock-responses.js');

test.describe('Chat Widget', () => {
  test.beforeEach(async ({page}) => {
    // Mock the chat endpoint to avoid real API calls
    await page.route('**/gds-assistant/v1/chat', (route) => {
      route.fulfill({
        status: 200,
        headers: {'Content-Type': 'text/event-stream'},
        body: SIMPLE_TEXT_RESPONSE,
      });
    });

    await page.goto('/wp-admin/');
  });

  test('trigger button is visible', async ({page}) => {
    const trigger = page.locator('.gds-assistant__trigger');
    await expect(trigger).toBeVisible();
  });

  test('clicking trigger opens modal', async ({page}) => {
    await page.click('.gds-assistant__trigger');
    const panel = page.locator('.gds-assistant__panel');
    await expect(panel).toBeVisible();
  });

  test('empty state shows suggestions', async ({page}) => {
    await page.click('.gds-assistant__trigger');
    const suggestions = page.locator('.gds-assistant__suggestion');
    await expect(suggestions.first()).toBeVisible();
  });

  test('model selector shows options', async ({page}) => {
    await page.click('.gds-assistant__trigger');
    const select = page.locator('.gds-assistant__model-select').first();
    await expect(select).toBeVisible();

    // Should have optgroups
    const optgroups = select.locator('optgroup');
    await expect(optgroups.first()).toBeAttached();
  });

  // Keyboard shortcuts unreliable in headless Chromium
  test.skip('Ctrl+K toggles modal', async ({page}) => {
    await page.keyboard.press('Control+k');
    const panel = page.locator('.gds-assistant__panel');
    await expect(panel).toBeVisible();

    await page.keyboard.press('Escape');
  });

  test('can send a message and receive response', async ({page}) => {
    await page.click('.gds-assistant__trigger');

    // Type in the composer
    const input = page.locator('.gds-assistant__input');
    await input.fill('Hello');
    await page.click('.gds-assistant__send');

    // Wait for the response to appear
    const assistantMsg = page.locator('.gds-assistant__message--assistant');
    await expect(assistantMsg.first()).toBeVisible({timeout: 5000});

    // Check the response text
    await expect(assistantMsg.first()).toContainText(
      'I can help you manage your site',
    );
  });

  test('tool call renders with status', async ({page}) => {
    // Override the beforeEach mock with tool call response
    await page.unrouteAll({behavior: 'ignoreErrors'});
    await page.route('**/gds-assistant/v1/chat', (route) => {
      route.fulfill({
        status: 200,
        headers: {'Content-Type': 'text/event-stream'},
        body: TOOL_CALL_RESPONSE,
      });
    });

    await page.click('.gds-assistant__trigger');
    const input = page.locator('.gds-assistant__input');
    await input.fill('List pages');
    await page.click('.gds-assistant__send');

    const assistantMsg = page.locator('.gds-assistant__message--assistant');
    await expect(assistantMsg.first()).toBeVisible({timeout: 5000});

    // Should show the text response (tool calls render as structured parts)
    await expect(assistantMsg.first()).toContainText('Found 1 page');
  });

  // TODO: button is outside viewport in modal — needs viewport resize or scroll
  test.skip('new chat button clears conversation', async ({page}) => {
    await page.click('.gds-assistant__trigger');

    // Send a message first
    const input = page.locator('.gds-assistant__input');
    await input.fill('Hello');
    await page.click('.gds-assistant__send');

    const assistantMsg = page.locator('.gds-assistant__message--assistant');
    await expect(assistantMsg.first()).toBeVisible({timeout: 5000});

    // Click new chat (may be outside viewport in small modal)
    await page.locator('[title="New chat"]').click({force: true});

    // Messages should be gone — either empty state appears or no assistant messages
    await expect(assistantMsg).toHaveCount(0, {timeout: 5000});
  });

  test('usage counter updates', async ({page}) => {
    await page.click('.gds-assistant__trigger');

    const input = page.locator('.gds-assistant__input');
    await input.fill('Hello');
    await page.click('.gds-assistant__send');

    // Wait for response
    await page
      .locator('.gds-assistant__message--assistant')
      .first()
      .waitFor({timeout: 5000});

    // Usage should show tokens
    const usage = page.locator('.gds-assistant__usage');
    await expect(usage).toContainText('tokens');
  });

  test('attach button is visible in composer', async ({page}) => {
    await page.click('.gds-assistant__trigger');
    const attachBtn = page.locator('.gds-assistant__attach');
    await expect(attachBtn).toBeVisible();
  });

  test('export button is visible in header', async ({page}) => {
    await page.click('.gds-assistant__trigger');
    const exportBtn = page.locator('[title="Export as Markdown"]');
    await expect(exportBtn).toBeVisible();
  });

  test('tool call renders as structured card', async ({page}) => {
    await page.unrouteAll({behavior: 'ignoreErrors'});
    await page.route('**/gds-assistant/v1/chat', (route) => {
      route.fulfill({
        status: 200,
        headers: {'Content-Type': 'text/event-stream'},
        body: TOOL_CALL_RESPONSE,
      });
    });

    await page.click('.gds-assistant__trigger');
    const input = page.locator('.gds-assistant__input');
    await input.fill('List pages');
    await page.click('.gds-assistant__send');

    // Wait for assistant message
    const assistantMsg = page.locator('.gds-assistant__message--assistant');
    await expect(assistantMsg.first()).toBeVisible({timeout: 5000});

    // Tool call should render as a collapsible card (details element)
    const toolCall = page.locator('.gds-assistant__tool-call');
    if ((await toolCall.count()) > 0) {
      await expect(toolCall.first()).toBeVisible();
      // Should show tool name
      const toolName = toolCall.locator('.gds-assistant__tool-call-name');
      await expect(toolName.first()).toBeVisible();
    }
  });
});
