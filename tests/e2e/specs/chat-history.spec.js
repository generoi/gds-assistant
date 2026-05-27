const {test, expect} = require('@playwright/test');

/**
 * Resuming a past conversation from the chat history. Also guards the
 * history-restore path of the tool-call-parts refactor: a stored tool_use
 * block must come back as a rendered tool-call component, not inline text.
 */
const CONVERSATION_LIST = [
  {
    uuid: 'test-hist-1',
    title: 'Past chat about pages',
    total_input_tokens: 1000,
    total_output_tokens: 50,
  },
];

const CONVERSATION_DETAIL = {
  uuid: 'test-hist-1',
  title: 'Past chat about pages',
  messages: [
    {role: 'user', content: 'List the pages'},
    {
      role: 'assistant',
      content: [
        {type: 'text', text: 'Listing the pages.'},
        {
          type: 'tool_use',
          id: 'toolu_hist1',
          name: 'gds__content-list',
          input: {type: 'pages'},
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_hist1',
          content: '{"posts":[{"id":1,"title":"Home"}],"total":1}',
        },
      ],
    },
    {role: 'assistant', content: [{type: 'text', text: 'Found 1 page: Home.'}]},
  ],
};

test.describe('Chat history', () => {
  test.beforeEach(async ({page}) => {
    await page.route('**/gds-assistant/v1/conversations**', (route) => {
      const path = new URL(route.request().url()).pathname;
      const isDetail = /\/conversations\/.+/.test(path);
      route.fulfill({
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(isDetail ? CONVERSATION_DETAIL : CONVERSATION_LIST),
      });
    });
    await page.goto('/wp-admin/');
  });

  test('resuming a conversation restores its messages and tool calls', async ({
    page,
  }) => {
    await page.click('.gds-assistant__trigger');

    // Open history → the mocked list appears.
    await page.click('[title="Chat history"]');
    const item = page.locator('.gds-assistant__history-item').first();
    await expect(item).toBeVisible({timeout: 5000});
    await expect(item).toContainText('Past chat about pages');

    // Resume it.
    await item.click();

    // Restored text + the tool call as a real component (not inline text).
    await expect(
      page.locator('.gds-assistant__message--assistant').last(),
    ).toContainText('Found 1 page', {timeout: 5000});
    const toolCall = page.locator('.gds-assistant__tool-call').first();
    await expect(toolCall).toBeVisible();
    await expect(toolCall).toContainText('gds/content-list');
  });
});
