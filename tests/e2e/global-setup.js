import {chromium} from '@playwright/test';
import fs from 'fs';
import path from 'path';

const WP_BASE_URL = process.env.WP_BASE_URL || 'http://localhost:8889';
const WP_USERNAME = process.env.WP_USERNAME || 'admin';
const WP_PASSWORD = process.env.WP_PASSWORD || 'password';

export default async function globalSetup() {
  const storageDir = path.join(import.meta.dirname, 'artifacts');
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, {recursive: true});
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Log in to WordPress
  await page.goto(`${WP_BASE_URL}/wp-login.php`);
  await page.fill('#user_login', WP_USERNAME);
  await page.fill('#user_pass', WP_PASSWORD);
  await page.click('#wp-submit');
  await page.waitForURL('**/wp-admin/**');

  // Save authentication state
  await page
    .context()
    .storageState({path: path.join(storageDir, 'storage-state.json')});
  await browser.close();
}
