const {test, expect} = require('@playwright/test');
const {
  TOOL_APPROVAL_RESPONSE,
  TOOL_APPROVAL_RESOLVED,
  TOOL_DENIAL_RESOLVED,
  TOOL_APPROVAL_DELETE_RESPONSE,
  TOOL_APPROVAL_DELETE_RESOLVED,
  TOOL_APPROVAL_WITH_USE_START,
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
    // No assistant message should claim the cache was cleared. (Count-based:
    // the deny flow legitimately yields multiple assistant messages, so a bare
    // not.toContainText would trip Playwright's strict-mode multi-match check.)
    await expect(
      page.locator('.gds-assistant__message--assistant', {
        hasText: 'Cache cleared',
      }),
    ).toHaveCount(0);
  });
});

/**
 * The approval render path itself: a pending action shows as a compact
 * tool-call card (not verbose "```json … Waiting for approval```" text), and
 * after approval that SAME card stays in the thread, flips to Done, and gains
 * an Undo button. Guards the regression where approved tools left no record
 * and no way to undo.
 */
test.describe('Chat approval rendering', () => {
  test.beforeEach(async ({page}) => {
    await page.route('**/gds-assistant/v1/chat', (route) => {
      const body = route.request().postData() || '';
      let response = TOOL_APPROVAL_DELETE_RESPONSE;
      if (body.includes('__tool_approved__')) {
        response = TOOL_APPROVAL_DELETE_RESOLVED;
      }
      route.fulfill({
        status: 200,
        headers: {'Content-Type': 'text/event-stream'},
        body: response,
      });
    });
    await page.goto('/wp-admin/');
    await page.click('.gds-assistant__trigger');
    await page.locator('.gds-assistant__input').fill('Delete page 13589');
    await page.click('.gds-assistant__send');
  });

  test('pending approval renders as a compact tool-call card', async ({
    page,
  }) => {
    const card = page.locator('.gds-assistant__tool-call--approval').first();
    await expect(card).toBeVisible({timeout: 5000});
    await expect(card.locator('.gds-assistant__tool-call-name')).toContainText(
      'gds/content-delete',
    );
    await expect(card).toContainText('Approval required');

    // The old verbose text rendering must be gone.
    const messages = page.locator('.gds-assistant__message--assistant');
    await expect(messages).not.toContainText('Waiting for approval');
    await expect(messages).not.toContainText('```json');
  });

  test('approving keeps the card and surfaces an Undo button', async ({
    page,
  }) => {
    await expect(
      page.locator('.gds-assistant__tool-call--approval').first(),
    ).toBeVisible({timeout: 5000});

    await page.locator('.gds-assistant__approval-btn--approve').first().click();

    // The card persists (history) and flips out of the approval state…
    const card = page.locator('.gds-assistant__tool-call').first();
    await expect(card).toBeVisible({timeout: 5000});
    await expect(card).toContainText('gds/content-delete');
    // …gaining an Undo button now that the reversible action has run.
    await expect(
      page.locator('.gds-assistant__tool-undo-btn').first(),
    ).toBeVisible({timeout: 5000});
    // And the follow-up text streams in.
    await expect(
      page.locator('.gds-assistant__message--assistant').last(),
    ).toContainText('Deleted page 13589');
  });
});

/**
 * Regression: a real approval flow streams tool_use_start AND then
 * tool_approval_required for the same tool id. The UI must show exactly ONE
 * card (not a duplicate stuck on "Running" after approval).
 */
test.describe('Chat approval — single card for tool_use_start + approval', () => {
  test.beforeEach(async ({page}) => {
    await page.route('**/gds-assistant/v1/chat', (route) => {
      const body = route.request().postData() || '';
      let response = TOOL_APPROVAL_WITH_USE_START;
      if (body.includes('__tool_approved__')) {
        response = TOOL_APPROVAL_DELETE_RESOLVED;
      }
      route.fulfill({
        status: 200,
        headers: {'Content-Type': 'text/event-stream'},
        body: response,
      });
    });
    await page.goto('/wp-admin/');
    await page.click('.gds-assistant__trigger');
    await page.locator('.gds-assistant__input').fill('Delete page 22405');
    await page.click('.gds-assistant__send');
  });

  test('renders one card before and after approval (no stuck Running)', async ({
    page,
  }) => {
    // Exactly one card, in the approval state.
    await expect(page.locator('.gds-assistant__tool-call--approval')).toHaveCount(
      1,
      {timeout: 5000},
    );
    await expect(page.locator('.gds-assistant__tool-call')).toHaveCount(1);

    await page.locator('.gds-assistant__approval-btn--approve').first().click();

    // Still exactly one card — now Done with an Undo button, never a second
    // card lingering on "Running".
    await expect(page.locator('.gds-assistant__tool-call')).toHaveCount(1);
    await expect(
      page.locator('.gds-assistant__tool-call-status--done'),
    ).toBeVisible({timeout: 5000});
    await expect(
      page.locator('.gds-assistant__tool-call', {hasText: 'Running'}),
    ).toHaveCount(0);
    await expect(page.locator('.gds-assistant__tool-undo-btn')).toBeVisible();
  });
});
