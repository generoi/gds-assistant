const {test, expect} = require('@playwright/test');
const {
  SIMPLE_TEXT_RESPONSE,
  TOOL_CALL_RESPONSE,
  TOOL_APPROVAL_RESPONSE,
  TOOL_DUPLICATE_ID_RESPONSE,
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

  test('close button collapses the panel', async ({page}) => {
    await page.click('.gds-assistant__trigger');
    await expect(page.locator('.gds-assistant__panel')).toBeVisible();

    await page.click('.gds-assistant__header-btn--close');
    await expect(page.locator('.gds-assistant__panel')).toBeHidden();
  });

  test('history, system context + export live in the overflow menu', async ({
    page,
  }) => {
    await page.click('.gds-assistant__trigger');
    // Hidden until the "⋯" menu opens.
    await expect(page.locator('.gds-assistant__more-menu')).toHaveCount(0);
    await page.click('[title="More"]');
    const menu = page.locator('.gds-assistant__more-menu');
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('Chat history');
    await expect(menu).toContainText('Edit system context');
    await expect(menu.locator('[title="Export as Markdown"]')).toBeVisible();
  });

  test('opening one panel closes the other', async ({page}) => {
    await page.click('.gds-assistant__trigger');
    await page.click('[title="Skills"]');
    await expect(page.locator('.gds-assistant__skills-list')).toBeVisible();

    // Open history from the "⋯" menu — skills should close.
    await page.click('[title="More"]');
    await page.click('.gds-assistant__more-menu [title="Chat history"]');
    await expect(page.locator('.gds-assistant__history-list')).toBeVisible();
    await expect(page.locator('.gds-assistant__skills-list')).toHaveCount(0);
  });

  test('a panel close button dismisses it', async ({page}) => {
    await page.click('.gds-assistant__trigger');
    await page.click('[title="Skills"]');
    const panel = page.locator('.gds-assistant__skills-list');
    await expect(panel).toBeVisible();

    await panel.locator('.gds-assistant__panel-head-close').click();
    await expect(panel).toHaveCount(0);
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

  // Ctrl+K not dispatched in headless Chromium on Linux CI
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

    // First message has tool call text, second has the response
    await expect(assistantMsg.last()).toContainText('Found 1 page');
  });

  test('new chat button clears conversation', async ({page}) => {
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

  test('export is available in the overflow menu', async ({page}) => {
    await page.click('.gds-assistant__trigger');
    await page.click('[title="More"]');
    const exportBtn = page.locator(
      '.gds-assistant__more-menu [title="Export as Markdown"]',
    );
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

    // Tool call renders as a structured card (a real component, not inline
    // text). Unconditional now that tool calls route through tools.Fallback.
    const toolCall = page.locator('.gds-assistant__tool-call');
    await expect(toolCall.first()).toBeVisible({timeout: 5000});
    await expect(
      toolCall.locator('.gds-assistant__tool-call-name').first(),
    ).toBeVisible();
  });

  test('tool approval shows approve/deny buttons', async ({page}) => {
    await page.unrouteAll({behavior: 'ignoreErrors'});
    await page.route('**/gds-assistant/v1/chat', (route) => {
      route.fulfill({
        status: 200,
        headers: {'Content-Type': 'text/event-stream'},
        body: TOOL_APPROVAL_RESPONSE,
      });
    });

    await page.click('.gds-assistant__trigger');
    const input = page.locator('.gds-assistant__input');
    await input.fill('Clear the cache');
    await page.click('.gds-assistant__send');

    // Should show approval bar
    const approvalBar = page.locator('.gds-assistant__approval-bar');
    await expect(approvalBar).toBeVisible({timeout: 5000});

    // Should have approve and deny buttons
    const approveBtn = approvalBar.locator(
      '.gds-assistant__approval-btn--approve',
    );
    const denyBtn = approvalBar.locator('.gds-assistant__approval-btn--deny');
    await expect(approveBtn).toBeVisible();
    await expect(denyBtn).toBeVisible();
  });

  test('export button works after sending message', async ({page}) => {
    await page.click('.gds-assistant__trigger');

    // Send a message first so there's content to export
    const input = page.locator('.gds-assistant__input');
    await input.fill('Hello');
    await page.click('.gds-assistant__send');

    const assistantMsg = page.locator('.gds-assistant__message--assistant');
    await expect(assistantMsg.first()).toBeVisible({timeout: 5000});

    // Export lives in the "⋯" overflow menu now.
    await page.click('[title="More"]');
    const exportBtn = page.locator(
      '.gds-assistant__more-menu [title="Export as Markdown"]',
    );
    await expect(exportBtn).toBeVisible();
    // Click triggers a Blob download via JS — hard to capture in Playwright
    // Just verify no JS error on click
    await exportBtn.click({force: true});
  });

  test('tool calls reusing one id render without crashing', async ({page}) => {
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.unrouteAll({behavior: 'ignoreErrors'});
    await page.route('**/gds-assistant/v1/chat', (route) => {
      route.fulfill({
        status: 200,
        headers: {'Content-Type': 'text/event-stream'},
        body: TOOL_DUPLICATE_ID_RESPONSE,
      });
    });

    await page.click('.gds-assistant__trigger');
    await page.locator('.gds-assistant__input').fill('Delete both pages');
    await page.click('.gds-assistant__send');

    // Both cards render (the duplicate id is suffixed, not dropped) and the
    // turn completes — a "Duplicate key … in tapResources" crash would blow
    // away the tree instead.
    await expect(page.locator('.gds-assistant__tool-call')).toHaveCount(2, {
      timeout: 5000,
    });
    await expect(
      page.locator('.gds-assistant__message--assistant').last(),
    ).toContainText('Deleted both pages');
    expect(
      pageErrors.filter((m) => /Duplicate key|tapResources/.test(m)),
    ).toEqual([]);
  });

  test('no empty assistant bubble appears while waiting for a response', async ({
    page,
  }) => {
    // Hold the /chat response open so we can inspect the "waiting" state.
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    await page.unrouteAll({behavior: 'ignoreErrors'});
    await page.route('**/gds-assistant/v1/chat', async (route) => {
      await held;
      await route.fulfill({
        status: 200,
        headers: {'Content-Type': 'text/event-stream'},
        body: SIMPLE_TEXT_RESPONSE,
      });
    });

    await page.click('.gds-assistant__trigger');
    await page.locator('.gds-assistant__input').fill('Hello');
    await page.click('.gds-assistant__send');

    // We're now waiting: the composer shows Cancel (Send is hidden). There must
    // be no assistant bubble yet — the empty stub used to render with just a
    // copy button.
    await expect(page.locator('.gds-assistant__cancel')).toBeVisible({
      timeout: 5000,
    });
    await expect(
      page.locator('.gds-assistant__message--assistant'),
    ).toHaveCount(0);

    release();
    await expect(
      page.locator('.gds-assistant__message--assistant').first(),
    ).toContainText('I can help', {timeout: 5000});
  });
});
