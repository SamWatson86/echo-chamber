import { expect, test } from "@playwright/test";

const MAC_SAFARI_USER_AGENT = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  "AppleWebKit/605.1.15 (KHTML, like Gecko)",
  "Version/18.5 Safari/605.1.15",
].join(" ");

const DIAGNOSTICS_PREFIX = "echo-web-diagnostics-";
const CONSENT_KEY = `${DIAGNOSTICS_PREFIX}consent-v1`;
const INSTALL_KEY = `${DIAGNOSTICS_PREFIX}install-v1`;
const QUEUE_KEY = `${DIAGNOSTICS_PREFIX}queue-v1`;
const STATUS_KEY = `${DIAGNOSTICS_PREFIX}status-v1`;
const ACTIVE_KEY = `${DIAGNOSTICS_PREFIX}active-v1`;

test.use({ userAgent: MAC_SAFARI_USER_AGENT });

async function readStorage(page) {
  return page.evaluate(() => Object.fromEntries(
    Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter(Boolean)
      .map((key) => [key, localStorage.getItem(key)]),
  ));
}

function diagnosticsState(storage) {
  return Object.fromEntries(
    Object.entries(storage).filter(([key]) => key.startsWith(DIAGNOSTICS_PREFIX)),
  );
}

test("Mac web diagnostics remain data-free until consent and can be enabled from Settings", async ({ page }) => {
  const versionRequests = [];
  const diagnosticsUploads = [];

  await page.addInitScript(() => {
    Object.defineProperties(window.navigator, {
      maxTouchPoints: { configurable: true, get: () => 0 },
      platform: { configurable: true, get: () => "MacIntel" },
    });
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/version") {
      versionRequests.push(request.url());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          version: "0.6.33",
          git_sha: "abcdef123456",
          latest_client: "",
        }),
      });
      return;
    }
    if (url.pathname === "/api/online") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    if (url.pathname === "/api/diagnostics/v1/envelopes") {
      diagnosticsUploads.push({ method: request.method(), postData: request.postData() });
      await route.fulfill({ status: 202, contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({
      status: 501,
      contentType: "application/json",
      body: JSON.stringify({ error: "unmodeled viewer-test endpoint" }),
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  const consentModal = page.locator("#diagnostics-consent-modal");
  await expect(consentModal).toBeVisible();
  await expect(consentModal).toContainText("linked to your current Echo participant");
  await expect(page.locator("#diagnostics-consent-decline")).toBeFocused();
  await expect(page.locator("#diagnostics-settings-section")).not.toHaveClass(/\bhidden\b/);
  expect(await page.evaluate(() => ({
    consent: window.EchoWebDiagnosticsRuntime?.consentState(),
    platform: navigator.platform,
    touchPoints: navigator.maxTouchPoints,
    userAgent: navigator.userAgent,
  }))).toEqual({
    consent: "unset",
    platform: "MacIntel",
    touchPoints: 0,
    userAgent: MAC_SAFARI_USER_AGENT,
  });
  expect(diagnosticsState(await readStorage(page))).toEqual({});
  expect(versionRequests).toHaveLength(0);
  expect(diagnosticsUploads).toHaveLength(0);

  await page.getByRole("button", { name: "Keep Off" }).click();
  await expect(consentModal).toBeHidden();
  await expect.poll(() => page.evaluate(() => (
    window.EchoWebDiagnosticsRuntime?.consentState()
  ))).toBe("disabled");
  expect(diagnosticsState(await readStorage(page))).toEqual({
    [CONSENT_KEY]: "disabled-v1",
  });
  expect(versionRequests).toHaveLength(0);
  expect(diagnosticsUploads).toHaveLength(0);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(consentModal).toBeHidden();
  await expect(page.locator("#diagnostics-settings-section")).not.toHaveClass(/\bhidden\b/);
  await expect(page.locator("#diagnostics-enabled-toggle")).not.toBeChecked();
  expect(diagnosticsState(await readStorage(page))).toEqual({
    [CONSENT_KEY]: "disabled-v1",
  });
  expect(versionRequests).toHaveLength(0);
  expect(diagnosticsUploads).toHaveLength(0);

  const storageBeforeEnable = await readStorage(page);
  await page.evaluate(() => setSettingsPanelOpen(true));
  await expect(page.locator("#settings-panel")).toBeVisible();

  await page.locator("#diagnostics-enabled-toggle").check();
  await expect(page.locator("#diagnostics-action-status")).toHaveText("Diagnostics are on.");
  await expect(page.locator("#diagnostics-enabled-toggle")).toBeChecked();
  await expect.poll(() => versionRequests.length).toBe(1);

  const storageAfterEnable = await readStorage(page);
  const changedKeys = Array.from(new Set([
    ...Object.keys(storageBeforeEnable),
    ...Object.keys(storageAfterEnable),
  ])).filter((key) => storageBeforeEnable[key] !== storageAfterEnable[key]);
  expect(changedKeys.every((key) => key.startsWith(DIAGNOSTICS_PREFIX))).toBe(true);

  const enabledState = diagnosticsState(storageAfterEnable);
  expect(Object.keys(enabledState).sort()).toEqual([
    ACTIVE_KEY,
    CONSENT_KEY,
    INSTALL_KEY,
    QUEUE_KEY,
  ].sort());
  expect(enabledState[CONSENT_KEY]).toBe("enabled-v1");
  expect(enabledState[INSTALL_KEY]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(enabledState[STATUS_KEY]).toBeUndefined();

  const queue = JSON.parse(enabledState[QUEUE_KEY]);
  expect(queue.version).toBe(1);
  expect(queue.envelopes).toEqual([]);
  expect(queue.draft.events).toEqual([
    expect.objectContaining({
      event_type: "session_start",
      severity: "info",
      code: "session.start",
    }),
  ]);
  expect(JSON.parse(enabledState[ACTIVE_KEY])).toMatchObject({
    version: 1,
    sessions: {
      [queue.draft.session_id]: expect.objectContaining({
        started_at_ms: expect.any(Number),
        last_seen_ms: expect.any(Number),
      }),
    },
  });
  expect(diagnosticsUploads).toHaveLength(0);
});
