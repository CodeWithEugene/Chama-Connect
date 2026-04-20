import { defineConfig, devices } from "@playwright/test";
import * as path from "path";
import * as dotenv from "dotenv";

// Load root .env so recon tests can see credentials
dotenv.config({ path: path.resolve(__dirname, "../.env") });

export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "reports/html", open: "never" }],
    ["json", { outputFile: "reports/results.json" }],
  ],
  use: {
    baseURL: "https://chamaconnect.io",
    trace: "on",
    screenshot: "on",
    video: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
