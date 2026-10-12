import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, uniq, openAccount, dialog } from './fixtures.js';

test.describe('dashboard', () => {
  test('shows summary, balance chart and money flow', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toContainText('Demo Household');
    await expect(page.locator('.stat-card .stat-value').first()).toHaveText(/£[\d,]+\.\d\d/);
    await expect(page.locator('[data-chart] svg')).toBeVisible();
    await expect(page.locator('[data-flows] svg')).toBeVisible();
    // Forecast adds a dashed line and legend
    await page.locator('[data-forecast="3m"]').click();
    await expect(page.locator('.chart-legend')).toBeVisible();
    // Toggling an account changes the chart title
    await page.locator('[data-toggle-group]').first().click();
    await expect(page.locator('[data-chart-title]')).not.toHaveText('Cash in hand');
    // Choosing a summary card shows its accounts in the chart
    await page.locator('[data-card="savings"]').click();
    await expect(page.locator('[data-chart-title]')).toHaveText('Savings');
    await expect(page.locator('[data-card="savings"]')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('accounts and transactions', () => {
  test('create an account, add, edit, delete and undo a transaction', async ({ page }) => {
    const name = uniq('Test Bank');
    await page.goto('/');
    await page.locator('[data-add-account]').click();
    let d = await dialog(page);
    await d.locator('[name="name"]').fill(name);
    await d.locator('[name="opening"]').fill('100');
    await d.locator('button[type="submit"]').click();
    await expect(page.locator('.page-header h1')).toHaveText(name);
    await expect(page.locator('.page-header .pill').nth(1)).toContainText('£100.00');

    await page.keyboard.press('n');
    d = await dialog(page);
    await d.locator('[name="payee"]').fill('Corner Shop');
    await d.locator('[name="amount"]').fill('12.50');
    await d.locator('[name="categoryId"]').selectOption('sub-groceries');
    await d.getByRole('button', { name: 'Save', exact: true }).click();
    const row = page.locator('.tx-row', { hasText: 'Corner Shop' });
    await expect(row).toBeVisible();
    await expect(row.locator('.tx-amount')).toHaveText('−£12.50');
    await expect(row.locator('.tx-balance')).toHaveText('£87.50');
    await expect(page.locator('.page-header .pill').nth(1)).toContainText('£87.50');

    // Edit by clicking the row; switch it to money in
    await row.locator('.tx-payee').click();
    d = await dialog(page);
    await d.locator('.direction-toggle').click();
    await d.locator('[name="amount"]').fill('20');
    await d.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(row.locator('.tx-amount')).toHaveText('£20.00');
    await expect(page.locator('.page-header .pill').nth(1)).toContainText('£120.00');

    // Delete, then undo
    await row.hover();
    await row.locator('[data-delete]').click();
    await expect(page.locator('.tx-row', { hasText: 'Corner Shop' })).toHaveCount(0);
    await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('.tx-row', { hasText: 'Corner Shop' })).toBeVisible();
  });

  test('a liability account takes a positive amount owed', async ({ page }) => {
    const name = uniq('Store Card');
    await page.goto('/');
    await page.locator('[data-add-account]').click();
    const d = await dialog(page);
    await d.locator('[name="name"]').fill(name);
    await d.locator('[name="type"]').selectOption('credit');
    await expect(d.locator('[data-opening-label]')).toHaveText('Amount owed now');
    await d.locator('[name="opening"]').fill('250');
    await d.locator('button[type="submit"]').click();
    await expect(page.locator('.page-header .pill').nth(1)).toContainText('Owed');
    await expect(page.locator('.page-header .pill').nth(1)).toContainText('£250.00');
    await expect(page.locator('.account-item.active .account-item-balance')).toHaveClass(/negative/);
  });

  test('search and filters narrow the ledger', async ({ page }) => {
    await page.goto('/');
    await openAccount(page, 'Current Account');
    await expect(page.locator('.tx-row').first()).toBeVisible();
    await page.keyboard.press('/');
    await page.keyboard.type('Netflix');
    await expect(page.locator('.tx-row').first()).toContainText('Netflix');
    const payees = await page.locator('.tx-row .tx-payee').allTextContents();
    expect(payees.every(p => p === 'Netflix')).toBe(true);
    await expect(page.locator('[data-summary]')).toContainText('Out');
    await page.locator('[data-clear-filters]').click();
    await expect(page.locator('[name="q"]')).toHaveValue('');
  });
});

test.describe('transfers', () => {
  test('editing a transfer from the other account updates both sides', async ({ page }) => {
    await page.goto('/');
    await openAccount(page, 'Current Account');
    await page.keyboard.press('t');
    let d = await dialog(page);
    await d.locator('[name="toAccountId"]').selectOption({ label: 'Easy Access Saver' });
    await d.locator('[name="amount"]').fill('77.70');
    await d.locator('[name="description"]').fill('e2e transfer');
    await d.locator('button[type="submit"]').click();
    await expect(page.locator('.tx-row', { hasText: 'e2e transfer' }).first()).toBeVisible();

    await openAccount(page, 'Easy Access Saver');
    const incoming = page.locator('.tx-row', { hasText: 'e2e transfer' }).first();
    await expect(incoming.locator('.tx-amount')).toHaveText('£77.70');
    await incoming.locator('.tx-payee').click();
    d = await dialog(page);
    await expect(d.locator('.dialog-header h2')).toHaveText('Edit transfer');
    await d.locator('[name="amount"]').fill('80');
    await d.locator('button[type="submit"]').click();
    await expect(incoming.locator('.tx-amount')).toHaveText('£80.00');

    await openAccount(page, 'Current Account');
    await expect(page.locator('.tx-row', { hasText: 'e2e transfer' }).first().locator('.tx-amount')).toHaveText('−£80.00');
  });
});

test.describe('recurring', () => {
  test('add a recurring payment, then log it from the account', async ({ page }) => {
    const payee = uniq('Window Cleaner');
    await page.goto('/#/recurring');
    await page.locator('.page-header [data-add]').click();
    const d = await dialog(page);
    await d.locator('[name="accountId"]').selectOption({ label: 'Joint Account' });
    await d.locator('[name="payee"]').fill(payee);
    await d.locator('[name="amount"]').fill('15');
    await d.locator('button[type="submit"]').click();
    await expect(page.locator('.recurring-row', { hasText: payee })).toBeVisible();

    await openAccount(page, 'Joint Account');
    const item = page.locator('.upcoming-item', { hasText: payee });
    await expect(item).toBeVisible();
    await item.locator('[data-approve]').click();
    await expect(page.locator('.tx-row', { hasText: payee })).toBeVisible();
    await expect(page.locator('.upcoming-item', { hasText: payee })).toHaveCount(0);
  });
});

test.describe('import', () => {
  test('imports a bank CSV with paid in / paid out columns and spots duplicates', async ({ page }) => {
    const csv = [
      'Date,Description,Paid out,Paid in,Balance',
      '01/09/2026,"COFFEE, CO",3.20,,100.00',
      '02/09/2026,REFUND THING,,9.99,109.99',
      '03/09/2026,"BOOKS ""N"" MORE",12.00,,97.99'
    ].join('\n');
    const file = path.join(os.tmpdir(), `brisk-e2e-${Date.now()}.csv`);
    fs.writeFileSync(file, csv);

    const runImport = async () => {
      await page.locator('[data-more]').click();
      await page.getByRole('menuitem', { name: 'Import CSV' }).click();
      const d = await dialog(page);
      await d.locator('[data-file]').setInputFiles(file);
      await expect(d.locator('.mapping-grid')).toBeVisible();
      await expect(d.locator('input[name="amountMode"][value="split"]')).toBeChecked();
      await expect(d.locator('.table tbody tr')).toHaveCount(3);
      await d.locator('[data-next]').click();
      return d;
    };

    await page.goto('/');
    await openAccount(page, 'Credit Card');
    let d = await runImport();
    await d.locator('[data-import]').click();
    await expect(page.locator('.tx-row', { hasText: 'COFFEE, CO' })).toBeVisible();
    await expect(page.locator('.tx-row', { hasText: 'BOOKS "N" MORE' })).toBeVisible();

    d = await runImport();
    await expect(d.locator('.stat-card').nth(1)).toContainText('3');
    await expect(d.locator('[data-import]')).toBeDisabled();
    await d.locator('[data-dialog-close]').click();
    fs.rmSync(file, { force: true });
  });
});

test.describe('settings', () => {
  test('every settings tab opens', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-open-settings]').click();
    for (const tab of ['Categories', 'Payees', 'Accounts', 'Backups', 'Data check', 'Security', 'About & updates', 'General']) {
      await page.getByRole('tab', { name: tab }).click();
      await expect(page.locator('.settings-panel h3').first()).toBeVisible();
    }
  });

  test('add and rename a category without losing anything', async ({ page }) => {
    const name = uniq('Hobby');
    await page.goto('/');
    await page.locator('[data-open-settings]').click();
    await page.getByRole('tab', { name: 'Categories' }).click();
    await page.locator('[data-add-category]').click();
    let d = await dialog(page);
    await d.locator('[name="name"]').fill(name);
    await d.locator('[data-emoji="🎨"]').click();
    await d.locator('button[type="submit"]').click();
    const node = page.locator('.cat-node', { hasText: name });
    await expect(node).toBeVisible();
    await node.hover();
    await node.locator('[data-edit-category]').click();
    d = await dialog(page);
    await d.locator('[name="name"]').fill(`${name} renamed`);
    await d.locator('button[type="submit"]').click();
    await expect(page.locator('.cat-node', { hasText: `${name} renamed` })).toBeVisible();
  });

  test('save a backup on the server and run the data check', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-open-settings]').click();
    await page.getByRole('tab', { name: 'Backups' }).click();
    await page.locator('[data-create]').click();
    await expect(page.locator('[data-backup]').first()).toContainText('Saved by you');
    await page.getByRole('tab', { name: 'Data check' }).click();
    await expect(page.locator('.alert.success')).toContainText('healthy');
  });

  test('archive and restore an account', async ({ page }) => {
    await page.goto('/');
    await openAccount(page, 'Car Finance');
    await page.locator('[data-more]').click();
    await page.getByRole('menuitem', { name: 'Archive account' }).click();
    const d = await dialog(page);
    await d.getByRole('button', { name: 'Archive' }).click();
    await expect(page.locator('.account-item', { hasText: 'Car Finance' })).toHaveCount(0);
    await page.locator('[data-open-settings]').click();
    await page.getByRole('tab', { name: 'Accounts' }).click();
    await page.locator('[data-account]', { hasText: 'Car Finance' }).locator('[data-restore]').click();
    await expect(page.locator('.account-item', { hasText: 'Car Finance' })).toHaveCount(1);
  });

  test.afterEach(async ({ request }) => {
    // Whatever happened, leave the server without a password for the other tests
    await request.post('/api/auth/login', { headers: { 'X-Brisk-Request': '1' }, data: { password: 'correct horse' } }).catch(() => {});
    await request.delete('/api/auth/password', { headers: { 'X-Brisk-Request': '1' }, data: { currentPassword: 'correct horse' } }).catch(() => {});
  });

  test('password protection: set, sign out, sign in, remove', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-open-settings]').click();
    await page.getByRole('tab', { name: 'Security' }).click();
    await page.locator('[name="newPassword"]').fill('correct horse');
    await page.locator('[name="confirm"]').fill('correct horse');
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.locator('.alert.success')).toContainText('password is set');
    await page.locator('[data-dialog-close]').click();

    await page.locator('[data-logout]').click();
    await expect(page.locator('.login-card')).toBeVisible();
    await page.locator('[name="password"]').fill('wrong password');
    await page.locator('.login-card button[type="submit"]').click();
    await expect(page.locator('.login-card [data-error]')).toContainText('not right');
    await page.locator('[name="password"]').fill('correct horse');
    await page.locator('.login-card button[type="submit"]').click();
    await expect(page.locator('.sidebar')).toBeVisible();

    await page.locator('[data-open-settings]').click();
    await page.getByRole('tab', { name: 'Security' }).click();
    await page.locator('[name="currentPassword"]').fill('correct horse');
    await page.locator('[data-remove]').click();
    await expect(page.locator('.alert.warning')).toContainText('No password');
  });
});

test.describe('phone @phone', () => {
  test('menu drawer, account view and add transaction work on a phone @phone', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.topbar')).toBeVisible();
    await page.locator('[data-open-nav]').click();
    await expect(page.locator('.app.nav-open')).toBeVisible();
    await page.locator('.account-item', { hasText: 'Joint Account' }).click();
    await expect(page.locator('.app.nav-open')).toHaveCount(0);
    await expect(page.locator('.topbar-title')).toHaveText('Joint Account');
    await page.locator('.page-actions [data-add]').click();
    const d = await dialog(page);
    await d.locator('[name="payee"]').fill('Phone Test');
    await d.locator('[name="amount"]').fill('3');
    await d.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.tx-row', { hasText: 'Phone Test' })).toBeVisible();
  });
});
