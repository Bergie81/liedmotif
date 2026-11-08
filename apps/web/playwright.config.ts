import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// Browser qualification runs against the development-only harness pages (the
// DSP harness and the offline-store harness). It avoids authentication,
// Postgres and provider calls, and product pages except the Offline Library,
// which only a real browser with the network cut can prove; everything else
// stays independent of the in-progress UI design.
const PORT = 2206;
const baseURL = `http://127.0.0.1:${PORT}`;

// The harness reads no stored object, but the server's boot posture check
// refuses a storage root it cannot write — so pin the backend to a throwaway
// root created here. Left to the environment, whether the server starts at all
// depends on the machine holding the real data volume: on a bare CI runner the
// default `/data` does not exist and the boot fails before a page is served.
const dataRoot = fileURLToPath(new URL('.playwright/data', import.meta.url));
mkdirSync(dataRoot, { recursive: true });

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium-audio',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: `${baseURL}/dev/blend-harness`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      BETTER_AUTH_SECRET: 'browser-audio-harness-secret-000000000000',
      APP_PUBLIC_URL: baseURL,
      NODE_ENV: 'development',
      LOG_LEVEL: 'warn',
      STORAGE_PROVIDER: 'local-fs',
      DATA_DIR: dataRoot,
      // Lets a dev page hydrate with the network cut (see next.config.mjs).
      LIEDMOTIF_BROWSER_HARNESS: '1',
    },
  },
});
