const {defineConfig} = require('@playwright/test');
const path = require('path');

const e2eDir = __dirname;

module.exports = defineConfig({
  testDir: path.join(e2eDir, 'specs'),
  fullyParallel: false, // WordPress shares state, run sequentially
  workers: 1,
  retries: 0,
  reporter:
    process.env.CI ?
      [['html', {outputFolder: path.join(e2eDir, 'artifacts', 'report')}]]
    : 'html',
  use: {
    baseURL: process.env.WP_BASE_URL || 'http://localhost:8889',
    storageState: path.join(e2eDir, 'artifacts', 'storage-state.json'),
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  globalSetup: path.join(e2eDir, 'global-setup.js'),
  outputDir: path.join(e2eDir, 'artifacts', 'test-results'),
});
