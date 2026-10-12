// Browser tests. They start their own server on a throwaway data folder filled with demo data,
// so they never touch real data. Run with: npm run test:e2e
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT) || 3999;
const launchOptions = process.env.CHROME ? { executablePath: process.env.CHROME } : {};

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.js',
  timeout: 30000,
  expect: { timeout: 7000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1360, height: 860 } }, grepInvert: /@phone/ },
    { name: 'phone', use: { ...devices['Pixel 7'], launchOptions }, grep: /@phone/ }
  ],
  webServer: {
    command: 'node e2e/start-server.js',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 30000,
    env: { E2E_PORT: String(PORT) }
  }
});
