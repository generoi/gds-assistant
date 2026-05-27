const {test, expect} = require('@playwright/test');
const {SIMPLE_TEXT_RESPONSE} = require('../fixtures/mock-responses.js');

/**
 * Chat persistence across full-page wp-admin navigations: an open panel, a
 * half-written draft, and the active conversation all survive a page reload.
 * Guards the localStorage-backed restore wiring (defaultOpen + composer draft
 * + active-conversation pointer).
 */

// SIMPLE_TEXT_RESPONSE streams conversation_id "test-conv-1"; the reload then
// restores that thread via GET /conversations/test-conv-1.
const RESTORED_DETAIL = {
  uuid: 'test-conv-1',
  title: 'Saved chat',
  total_input_tokens: 500,
  total_output_tokens: 20,
  // Per-message timestamps (epoch ms) are persisted with the conversation and
  // must render on restore.
  messages: [
    {role: 'user', content: 'Hello', ts: 1700000000000},
    {
      role: 'assistant',
      content: [{type: 'text', text: 'I can help you manage your site.'}],
      ts: 1700000000000,
    },
  ],
};

test.describe('Chat persistence', () => {
  test.beforeEach(async ({page}) => {
    await page.route('**/gds-assistant/v1/chat', (route) => {
      route.fulfill({
        status: 200,
        headers: {'Content-Type': 'text/event-stream'},
        body: SIMPLE_TEXT_RESPONSE,
      });
    });
    await page.route('**/gds-assistant/v1/conversations**', (route) => {
      // Match the full (decoded) URL, not pathname — under plain permalinks the
      // route lives in ?rest_route= and the pathname is just /index.php, which
      // misclassifies a detail request as the list.
      const url = decodeURIComponent(route.request().url());
      const isDetail = /\/conversations\/[\w-]+/.test(url);
      route.fulfill({
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(isDetail ? RESTORED_DETAIL : []),
      });
    });
    await page.goto('/wp-admin/');
  });

  test('reopens with the half-written draft after a page reload', async ({
    page,
  }) => {
    await page.click('.gds-assistant__trigger');
    await expect(page.locator('.gds-assistant__panel')).toBeVisible();

    // Type a draft but do NOT send it.
    const draft = 'a half written message';
    await page.locator('.gds-assistant__input').fill(draft);

    await page.reload();

    // The panel reopens itself (defaultOpen) and the draft is restored.
    const input = page.locator('.gds-assistant__input');
    await expect(page.locator('.gds-assistant__panel')).toBeVisible({
      timeout: 5000,
    });
    await expect(input).toHaveValue(draft, {timeout: 5000});
  });

  test('restores the active conversation after a page reload', async ({
    page,
  }) => {
    await page.click('.gds-assistant__trigger');

    await page.locator('.gds-assistant__input').fill('Hello');
    await page.click('.gds-assistant__send');
    await expect(
      page.locator('.gds-assistant__message--assistant').first(),
    ).toBeVisible({timeout: 5000});

    await page.reload();

    // After reload the panel reopens and the persisted thread is restored.
    await expect(page.locator('.gds-assistant__panel')).toBeVisible({
      timeout: 5000,
    });
    await expect(
      page.locator('.gds-assistant__message--assistant').first(),
    ).toContainText('I can help you manage your site', {timeout: 5000});
    // Persisted per-message timestamps render on the restored messages.
    await expect(
      page.locator('.gds-assistant__message-time').first(),
    ).toBeVisible({timeout: 5000});
  });

  test('a closed panel stays closed after a page reload', async ({page}) => {
    // Never opened — the panel must not auto-open on subsequent pages.
    await page.reload();
    await expect(page.locator('.gds-assistant__panel')).toBeHidden();
  });
});
