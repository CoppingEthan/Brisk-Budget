// The installable app: opening without the server, Back closing what's open, and the phone's
// tab bar.
import { test as plain } from '@playwright/test';
import { test, expect, uniq, openAccount, dialog } from './fixtures.js';

// Waits for the service worker to have saved the app and to be looking after the page
async function controlled(page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

const savedPaths = (page) => page.evaluate(async () => {
  const out = [];
  for (const name of await caches.keys()) {
    for (const request of await (await caches.open(name)).keys()) out.push(new URL(request.url).pathname);
  }
  return out;
});

test.describe('offline', () => {
  // Not the usual fixture: failed requests while offline are the point here
  plain("opens from the copy saved on the device when the server can't be reached", async ({ page, context }) => {
    const problems = [];
    page.on('pageerror', err => problems.push(err.message));
    page.on('console', msg => { if (msg.type() === 'error' && !msg.text().includes('Failed to load resource')) problems.push(msg.text()); });

    await page.goto('/');
    await expect(page.locator('.page-header h1')).toContainText('Demo Household');
    await controlled(page);
    await openAccount(page, 'Current Account');
    await expect(page.locator('.tx-row').first()).toBeVisible();

    // The app's own files are kept; nothing the server says about money ever is
    const saved = await savedPaths(page);
    expect(saved).toContain('/index.html');
    expect(saved).toContain('/js/main.js');
    expect(saved.filter(p => p.startsWith('/api/'))).toEqual([]);

    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('.unreachable h1')).toHaveText("Can't reach your Brisk Budget server");
    await page.locator('[data-retry]').click();
    await expect(page.locator('.unreachable h1')).toBeVisible();

    // Back online, it carries on by itself
    await context.setOffline(false);
    await expect(page.locator('.page-header h1')).toHaveText('Current Account');
    expect(problems).toEqual([]);
  });
});

test.describe('back button', () => {
  test('Back closes a dialog rather than leaving the page', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.page-header h1')).toContainText('Demo Household');
    await page.locator('.sidebar a[href="#/recurring"]').click();
    await expect(page.locator('.page-header h1')).toHaveText('Recurring');

    await page.locator('.page-header [data-add]').click();
    await dialog(page);
    await page.goBack();
    await expect(page.locator('.dialog-layer')).toHaveCount(0);
    await expect(page).toHaveURL(/#\/recurring$/);
    await expect(page.locator('.page-header h1')).toHaveText('Recurring');

    // Closed with its own button, a dialog leaves history as it found it
    await page.locator('.page-header [data-add]').click();
    const d = await dialog(page);
    await d.locator('[data-dialog-close]').click();
    await expect(page.locator('.dialog-layer')).toHaveCount(0);
    await page.goBack();
    await expect(page.locator('.page-header h1')).toContainText('Demo Household');
  });
});

test.describe('phone app @phone', () => {
  test('the tab bar moves between pages and adds a transaction from anywhere @phone', async ({ page }) => {
    const payee = uniq('Tab Bar Cafe');
    await page.goto('/');
    const bar = page.locator('.tabbar');
    await expect(bar).toBeVisible();
    await expect(bar.locator('[data-tab="dashboard"]')).toHaveAttribute('aria-current', 'page');
    await bar.locator('[data-tab="recurring"]').click();
    await expect(page.locator('.page-header h1')).toHaveText('Recurring');
    await expect(bar.locator('[data-tab="recurring"]')).toHaveAttribute('aria-current', 'page');

    // Away from any account, Add asks which one
    await bar.locator('[data-quick-add]').click();
    let d = await dialog(page);
    await d.locator('[name="accountId"]').selectOption({ label: 'Joint Account' });
    await d.locator('[name="payee"]').fill(payee);
    await d.locator('[name="amount"]').fill('4.20');
    await d.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('.toast', { hasText: `Added "${payee}" to Joint Account` }).getByRole('button', { name: 'View' }).click();
    await expect(page.locator('.page-header h1')).toHaveText('Joint Account');
    await expect(page.locator('.tx-row', { hasText: payee }).locator('.tx-amount')).toHaveText('−£4.20');
    await expect(bar.locator('[data-tab="accounts"]')).toHaveClass(/active/);

    // In an account, Add adds to that account
    await bar.locator('[data-quick-add]').click();
    d = await dialog(page);
    await expect(d.locator('[name="accountId"]')).toHaveCount(0);
    await d.locator('[data-dialog-close]').click();

    // and from elsewhere, the account used last comes first
    await bar.locator('[data-tab="dashboard"]').click();
    await expect(page.locator('.page-header h1')).toContainText('Demo Household');
    await bar.locator('[data-quick-add]').click();
    d = await dialog(page);
    await expect(d.locator('[name="accountId"] option:checked')).toHaveText('Joint Account');
  });

  test('Back closes the drawer or a dialog without leaving the page @phone', async ({ page }) => {
    await page.goto('/');
    await page.locator('.tabbar [data-tab="recurring"]').click();
    await expect(page.locator('.page-header h1')).toHaveText('Recurring');

    await page.locator('[data-open-nav]').click();
    await expect(page.locator('.app.nav-open')).toBeVisible();
    await page.goBack();
    await expect(page.locator('.app.nav-open')).toHaveCount(0);
    await expect(page.locator('.page-header h1')).toHaveText('Recurring');

    // An account picked in the drawer opens, and Back returns to where the drawer was opened
    await page.locator('[data-open-nav]').click();
    await page.locator('.account-item', { hasText: 'Joint Account' }).click();
    await expect(page.locator('.page-header h1')).toHaveText('Joint Account');
    await page.goBack();
    await expect(page.locator('.page-header h1')).toHaveText('Recurring');

    await page.locator('[data-quick-add]').click();
    await dialog(page);
    await page.goBack();
    await expect(page.locator('.dialog-layer')).toHaveCount(0);
    await expect(page.locator('.page-header h1')).toHaveText('Recurring');
  });

  test("the app icon's Add transaction shortcut opens straight into adding one @phone", async ({ page }) => {
    await page.goto('/?action=add');
    const d = await dialog(page);
    await expect(d.locator('.dialog-header h2')).toHaveText('Add transaction');
    await expect(d.locator('[name="accountId"]')).toBeVisible();
    await expect(page).toHaveURL(/:\d+\/$/); // the address is tidied, so a reload doesn't add again
  });

  test("controls are big enough for a finger, text boxes don't zoom, nothing scrolls sideways @phone", async ({ page }) => {
    const wide = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await page.goto('/');
    await expect(page.locator('.tabbar')).toBeVisible();
    const heights = await page.locator('.tabbar .tab-item').evaluateAll(els => els.map(e => e.getBoundingClientRect().height));
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
    expect(await wide()).toBe(0);

    await page.locator('[data-quick-add]').click();
    const d = await dialog(page);
    const fonts = await d.locator('.input, .select, .textarea').evaluateAll(els => els.map(e => parseFloat(getComputedStyle(e).fontSize)));
    expect(Math.min(...fonts)).toBeGreaterThanOrEqual(16);
    await expect(d.locator('[name="amount"]')).toHaveAttribute('inputmode', 'decimal');
    expect((await d.locator('[data-dialog-close]').boundingBox()).height).toBeGreaterThanOrEqual(44);
    await d.locator('[data-dialog-close]').click();

    await openAccount(page, 'Current Account');
    await expect(page.locator('.tx-row').first()).toBeVisible();
    expect(await wide()).toBe(0);
    await page.locator('.tabbar [data-tab="recurring"]').click();
    await expect(page.locator('.page-header h1')).toHaveText('Recurring');
    expect(await wide()).toBe(0);
  });
});
