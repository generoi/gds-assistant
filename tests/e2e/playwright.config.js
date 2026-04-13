import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  fullyParallel: false, // WordPress shares state, run sequentially
  workers: 1,
  retries: 0,
  reporter: 'html',
  use: {
    baseURL: process.env.WP_BASE_URL || 'http://localhost:8889',
    storageState: './artifacts/storage-state.json',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  globalSetup: './global-setup.js',
  outputDir: './artifacts/test-results',
});
