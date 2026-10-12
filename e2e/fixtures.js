import { test as base, expect } from '@playwright/test';

// Every test fails if the page logs an error or throws
export const test = base.extend({
  page: async ({ page }, use) => {
    const problems = [];
    page.on('pageerror', err => problems.push(`Uncaught: ${err.message}`));
    page.on('console', msg => {
      if (msg.type() === 'error' && !/Failed to load resource: the server responded with a status of 4\d\d/.test(msg.text())) {
        problems.push(`console.error: ${msg.text()}`);
      }
    });
    await use(page);
    expect(problems, 'browser errors').toEqual([]);
  }
});

export { expect };

export const uniq = (label) => `${label} ${Date.now().toString(36).slice(-5)}`;

// Open an account from the sidebar (on phones, through the menu)
export async function openAccount(page, name) {
  const toggle = page.locator('[data-open-nav]');
  if (await toggle.isVisible()) await toggle.click();
  await page.locator('.account-item', { hasText: name }).first().click();
  await expect(page.locator('.page-header h1')).toHaveText(name);
}

export async function dialog(page) {
  const d = page.locator('.dialog-layer.open .dialog').last();
  await expect(d).toBeVisible();
  return d;
}
