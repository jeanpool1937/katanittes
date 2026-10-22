import { defineConfig, devices } from '@playwright/test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.js',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8123',
    locale: 'es-ES',
    trace: 'off',
    actionTimeout: 15_000,
    screenshot: 'off',
    hasTouch: true,
  },
  projects: [
    {
      name: 'chromium-phone',
      testMatch: '*.spec.js',
      use: { ...devices['Pixel 5'], locale: 'es-ES', hasTouch: true, isMobile: true },
    },
    {
      name: 'webkit-phone',
      testMatch: '{mobile-taps,join-hang,bots-pace}.spec.js',
      use: { ...devices['iPhone 13'], locale: 'es-ES', hasTouch: true, isMobile: true },
    },
    {
      name: 'chromium-desktop',
      testMatch: 'mobile-taps.spec.js',
      use: { viewport: { width: 1280, height: 800 }, locale: 'es-ES', hasTouch: false, isMobile: false },
    },
  ],
  webServer: {
    command: 'node static-server.mjs',
    cwd: here,
    url: 'http://127.0.0.1:8123/',
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
