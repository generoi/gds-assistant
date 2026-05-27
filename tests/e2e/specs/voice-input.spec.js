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

    // Active/recording state is reflected on the button while listening —
    // assert the rendered style, not just the class, so a CSS rule that fails
    // to compile (e.g. bad nesting) is caught.
    await expect(mic).toHaveClass(/gds-assistant__mic--listening/);
    await expect(mic).toHaveCSS('background-color', 'rgb(214, 54, 56)');
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

  test('language picker sets the recognition language', async ({page}) => {
    await page.addInitScript(() => {
      window.__srLang = null;
      class FakeSpeechRecognition {
        start() {
          window.__srLang = this.lang;
          this.onstart && this.onstart();
        }
        stop() {
          this.onend && this.onend();
        }
      }
      window.SpeechRecognition = FakeSpeechRecognition;
    });
    await page.goto('/wp-admin/');
    // Languages normally come from Polylang via the localized config.
    await page.evaluate(() => {
      window.gdsAssistant = window.gdsAssistant || {};
      window.gdsAssistant.voiceLanguages = [
        {code: 'en-US', name: 'English', slug: 'en'},
        {code: 'sv-SE', name: 'Svenska', slug: 'sv'},
      ];
    });
    await page.click('.gds-assistant__trigger');

    const picker = page.locator('.gds-assistant__voice-lang');
    await expect(picker).toBeVisible();
    await picker.selectOption('sv-SE');
    await page.locator('.gds-assistant__mic').click();

    // The chosen language is what recognition starts with.
    await expect
      .poll(() => page.evaluate(() => window.__srLang))
      .toBe('sv-SE');
  });
});
