const {test, expect} = require('@playwright/test');

test.describe('Voice input', () => {
  test('mic dictates into the composer', async ({page}) => {
    // Stub the Web Speech API before the app loads: emit one final result.
    await page.addInitScript(() => {
      class FakeSpeechRecognition {
        start() {
          this.onstart && this.onstart();
          setTimeout(() => {
            this.onresult &&
              this.onresult({
                resultIndex: 0,
                results: [
                  Object.assign([{transcript: 'hello from voice'}], {
                    isFinal: true,
                  }),
                ],
              });
          }, 20);
        }
        stop() {
          this.onend && this.onend();
        }
      }
      window.SpeechRecognition = FakeSpeechRecognition;
    });

    await page.goto('/wp-admin/');
    await page.click('.gds-assistant__trigger');

    const mic = page.locator('.gds-assistant__mic');
    await expect(mic).toBeVisible();
    await mic.click();

    // Active/recording state is reflected on the button while listening.
    await expect(mic).toHaveClass(/gds-assistant__mic--listening/);
    await expect(page.locator('.gds-assistant__input')).toHaveValue(
      /hello from voice/,
      {timeout: 3000},
    );

    // Clicking again stops dictation and clears the active state.
    await mic.click();
    await expect(mic).not.toHaveClass(/gds-assistant__mic--listening/);
  });

  test('mic is hidden when Web Speech is unavailable', async ({page}) => {
    await page.addInitScript(() => {
      delete window.SpeechRecognition;
      delete window.webkitSpeechRecognition;
    });
    await page.goto('/wp-admin/');
    await page.click('.gds-assistant__trigger');
    await expect(page.locator('.gds-assistant__input')).toBeVisible();
    await expect(page.locator('.gds-assistant__mic')).toHaveCount(0);
  });
});
