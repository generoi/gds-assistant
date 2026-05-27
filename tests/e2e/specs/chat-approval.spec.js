const {test, expect} = require('@playwright/test');
const {
  TOOL_APPROVAL_RESPONSE,
  TOOL_APPROVAL_RESOLVED,
  TOOL_DENIAL_RESOLVED,
} = require('../fixtures/mock-responses.js');

/**
 * The approval (confirm) flow: a destructive tool pauses for approval, and one
 * click resolves it AND clears the whole bar. Guards the batch-clear fix —
 * previously the bar lingered after approving, which led to stray empty turns.
 */
test.describe('Chat tool approval', () => {
  test.beforeEach(async ({page}) => {
    // First /chat returns the approval prompt; the follow-up call carries the
    // user's decision — __tool_approved__ resolves and continues, __tool_denied__
    // resolves as denied (neither re-surfaces another approval prompt).
    await page.route('**/gds-assistant/v1/chat', (route) => {
      const body = route.request().postData() || '';
      let response = TOOL_APPROVAL_RESPONSE;
      if (body.includes('__tool_approved__')) {
        response = TOOL_APPROVAL_RESOLVED;
      } else if (body.includes('__tool_denied__')) {
        response = TOOL_DENIAL_RESOLVED;
      }
      route.fulfill({
        status: 200,
        headers: {'Content-Type': 'text/event-stream'},
        body: response,
      });
    });
    await page.goto('/wp-admin/');
  });

  async function requestDestructiveAction(page) {
    await page.click('.gds-assistant__trigger');
    await page.locator('.gds-assistant__input').fill('Clear the cache');
    await page.click('.gds-assistant__send');
    const bar = page.locator('.gds-assistant__approval-bar');
    await expect(bar).toBeVisible({timeout: 5000});
    return bar;
  }

  test('approving resolves the action and clears the bar', async ({page}) => {
    const bar = await requestDestructiveAction(page);

    await bar.locator('.gds-assistant__approval-btn--approve').click();

    // The bar clears on the single click (no lingering / re-click loop)…
    await expect(bar).toBeHidden({timeout: 5000});
    // …and the resolved turn streams in.
    await expect(
      page.locator('.gds-assistant__message--assistant').last(),
    ).toContainText('Cache cleared', {timeout: 5000});
  });

  test('denying clears the bar without running the action', async ({page}) => {
    const bar = await requestDestructiveAction(page);

    await bar.locator('.gds-assistant__approval-btn--deny').click();

    await expect(bar).toBeHidden({timeout: 5000});
    await expect(
      page.locator('.gds-assistant__message--assistant'),
    ).not.toContainText('Cache cleared');
  });
});
