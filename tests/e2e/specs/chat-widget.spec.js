import {test, expect} from '@playwright/test';
import {
  SIMPLE_TEXT_RESPONSE,
  TOOL_CALL_RESPONSE,
} from '../fixtures/mock-responses.js';

test.describe('Chat Widget', () => {
  test.beforeEach(async ({page}) => {
    // Mock the chat endpoint to avoid real API calls
    await page.route('**/wp-json/gds-assistant/v1/chat', (route) => {
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

  test('Cmd+K toggles modal', async ({page}) => {
    await page.keyboard.press('Meta+k');
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
    // Use tool call response
    await page.route('**/wp-json/gds-assistant/v1/chat', (route) => {
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

    // Should show tool name and "Done"
    await expect(assistantMsg.first()).toContainText('content-list');
    await expect(assistantMsg.first()).toContainText('Done');
  });

  test('new chat button clears conversation', async ({page}) => {
    await page.click('.gds-assistant__trigger');

    // Send a message first
    const input = page.locator('.gds-assistant__input');
    await input.fill('Hello');
    await page.click('.gds-assistant__send');

    const assistantMsg = page.locator('.gds-assistant__message--assistant');
    await expect(assistantMsg.first()).toBeVisible({timeout: 5000});

    // Click new chat
    await page.click('[title="New chat"]');

    // Empty state should be back
    const empty = page.locator('.gds-assistant__empty');
    await expect(empty).toBeVisible();
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
});
