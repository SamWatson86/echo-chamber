import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const port = Number.parseInt(process.env.PORT || "4175", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 9443) {
  throw new Error(`unsafe viewer test port: ${process.env.PORT || ""}`);
}

const baseURL = `http://127.0.0.1:${port}`;
const artifactRoot = process.env.ECHO_VIEWER_TEST_OUTPUT_DIR
  ? path.resolve(process.env.ECHO_VIEWER_TEST_OUTPUT_DIR)
  : null;
const htmlReport = artifactRoot ? path.join(artifactRoot, "playwright-report") : "playwright-report";
const testResults = artifactRoot ? path.join(artifactRoot, "test-results") : "test-results";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never", outputFolder: htmlReport }]]
    : [["list"], ["html", { open: "never", outputFolder: htmlReport }]],
  outputDir: testResults,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL,
    headless: true,
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
  webServer: {
    command: "node ./scripts/serve-viewer.mjs",
    env: {
      ...process.env,
      PORT: String(port),
    },
    url: `${baseURL}/healthz`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
