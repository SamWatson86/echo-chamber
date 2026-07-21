import { expect, test } from "@playwright/test";

const MAC_CHROME_USER_AGENT = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  "AppleWebKit/537.36 (KHTML, like Gecko)",
  "Chrome/152.0.0.0 Safari/537.36",
].join(" ");

const DIAGNOSTICS_PREFIX = "echo-web-diagnostics-";
const CONSENT_KEY = `${DIAGNOSTICS_PREFIX}consent-v1`;
const INSTALL_KEY = `${DIAGNOSTICS_PREFIX}install-v1`;
const QUEUE_KEY = `${DIAGNOSTICS_PREFIX}queue-v1`;
const STATUS_KEY = `${DIAGNOSTICS_PREFIX}status-v1`;
const ACTIVE_KEY = `${DIAGNOSTICS_PREFIX}active-v1`;

test.use({ userAgent: MAC_CHROME_USER_AGENT });

async function readStorage(page) {
  return page.evaluate(() => Object.fromEntries(
    Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter(Boolean)
      .map((key) => [key, localStorage.getItem(key)]),
  ));
}

async function installDesktopMacNavigator(page) {
  await page.addInitScript(() => {
    window.__echoUaHintRequests = 0;
    const userAgentData = {
      async getHighEntropyValues(hints) {
        window.__echoUaHintRequests += 1;
        return {
          fullVersionList: hints.includes("fullVersionList")
            ? [
              { brand: "Chromium", version: "152.0.8123.44" },
              { brand: "Google Chrome", version: "152.0.8123.44" },
            ]
            : [],
        };
      },
    };
    Object.defineProperties(window.navigator, {
      maxTouchPoints: { configurable: true, get: () => 0 },
      platform: { configurable: true, get: () => "MacIntel" },
      userAgentData: { configurable: true, get: () => userAgentData },
    });
  });
}

function diagnosticsState(storage) {
  return Object.fromEntries(
    Object.entries(storage).filter(([key]) => key.startsWith(DIAGNOSTICS_PREFIX)),
  );
}

test("late diagnostics callbacks from a replaced room are ignored", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const result = await page.evaluate(() => {
    const replacedRoom = {
      _echoDiagnosticsCommitted: true,
      _echoExpectedDisconnect: false,
    };
    const activeRoom = {
      _echoDiagnosticsCommitted: true,
      _echoExpectedDisconnect: false,
    };
    const uncommittedRoom = {
      _echoDiagnosticsCommitted: false,
      _echoExpectedDisconnect: false,
    };
    const expectedDisconnectRoom = {
      _echoDiagnosticsCommitted: true,
      _echoExpectedDisconnect: true,
    };
    const recorded = [];

    room = activeRoom;
    const callbackKinds = ["state", "reconnecting", "error"];
    const replacedResults = callbackKinds.map((kind) => (
      recordActiveRoomDiagnostic(replacedRoom, () => recorded.push(`replaced:${kind}`))
    ));
    const activeResults = callbackKinds.map((kind) => (
      recordActiveRoomDiagnostic(activeRoom, () => recorded.push(`active:${kind}`))
    ));

    room = uncommittedRoom;
    const uncommittedResult = recordActiveRoomDiagnostic(
      uncommittedRoom,
      () => recorded.push("uncommitted"),
    );
    room = expectedDisconnectRoom;
    const expectedDisconnectResult = recordActiveRoomDiagnostic(
      expectedDisconnectRoom,
      () => recorded.push("expected-disconnect"),
    );

    return {
      activeResults,
      expectedDisconnectResult,
      recorded,
      replacedResults,
      uncommittedResult,
    };
  });

  expect(result).toEqual({
    activeResults: [true, true, true],
    expectedDisconnectResult: false,
    recorded: ["active:state", "active:reconnecting", "active:error"],
    replacedResults: [false, false, false],
    uncommittedResult: false,
  });
});

test("fresh Mac stays inert until an exact canary invite, then remains data-free until consent", async ({ page }) => {
  const versionRequests = [];
  const diagnosticsUploads = [];

  await installDesktopMacNavigator(page);

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
  await page.evaluate(() => localStorage.setItem("echo-changelog-seen", CHANGELOG_LATEST));

  const consentModal = page.locator("#diagnostics-consent-modal");
  await expect(consentModal).toBeHidden();
  await expect(page.locator("#diagnostics-settings-section")).toHaveClass(/\bhidden\b/);
  expect(await page.evaluate(() => window.EchoWebDiagnosticsRuntime)).toBeUndefined();
  expect(diagnosticsState(await readStorage(page))).toEqual({});
  expect(versionRequests).toHaveLength(0);
  expect(diagnosticsUploads).toHaveLength(0);
  expect(await page.evaluate(() => window.__echoUaHintRequests)).toBe(0);

  await page.goto("/?echoWebDiagnosticsCanary=1&echoWebDiagnosticsCanary=1", {
    waitUntil: "domcontentloaded",
  });
  await expect(consentModal).toBeHidden();
  await expect(page.locator("#diagnostics-settings-section")).toHaveClass(/\bhidden\b/);
  expect(await page.evaluate(() => window.EchoWebDiagnosticsRuntime)).toBeUndefined();
  expect(diagnosticsState(await readStorage(page))).toEqual({});
  expect(versionRequests).toHaveLength(0);
  expect(diagnosticsUploads).toHaveLength(0);

  await page.goto("/?echoWebDiagnosticsCanary=1", { waitUntil: "domcontentloaded" });

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
    userAgent: MAC_CHROME_USER_AGENT,
  });
  expect(diagnosticsState(await readStorage(page))).toEqual({});
  expect(versionRequests).toHaveLength(0);
  expect(diagnosticsUploads).toHaveLength(0);
  expect(await page.evaluate(() => window.__echoUaHintRequests)).toBe(0);
  expect(new URL(page.url()).searchParams.get("echoWebDiagnosticsCanary")).toBe("1");

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
  expect(new URL(page.url()).searchParams.has("echoWebDiagnosticsCanary")).toBe(false);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(consentModal).toBeHidden();
  await expect(page.locator("#diagnostics-settings-section")).not.toHaveClass(/\bhidden\b/);
  await expect(page.locator("#diagnostics-enabled-toggle")).not.toBeChecked();
  expect(diagnosticsState(await readStorage(page))).toEqual({
    [CONSENT_KEY]: "disabled-v1",
  });
  expect(versionRequests).toHaveLength(0);
  expect(diagnosticsUploads).toHaveLength(0);
  expect(await page.evaluate(() => window.__echoUaHintRequests)).toBe(0);

  const storageBeforeEnable = await readStorage(page);
  await page.evaluate(() => setSettingsPanelOpen(true));
  await expect(page.locator("#settings-panel")).toBeVisible();

  await page.locator("#diagnostics-enabled-toggle").check();
  await expect(page.locator("#diagnostics-action-status")).toHaveText("Diagnostics are on.");
  await expect(page.locator("#diagnostics-enabled-toggle")).toBeChecked();
  await expect.poll(() => versionRequests.length).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__echoUaHintRequests)).toBe(1);

  const storageAfterEnable = await readStorage(page);
  const changedKeys = Array.from(new Set([
    ...Object.keys(storageBeforeEnable),
    ...Object.keys(storageAfterEnable),
  ])).filter((key) => storageBeforeEnable[key] !== storageAfterEnable[key]);
  expect(changedKeys.filter((key) => !key.startsWith(DIAGNOSTICS_PREFIX))).toEqual([]);

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

test("Allow Diagnostics consumes the invite and enrolls normal-URL reloads", async ({ page }) => {
  await installDesktopMacNavigator(page);

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/version") {
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
    await route.fulfill({
      status: 501,
      contentType: "application/json",
      body: JSON.stringify({ error: "unmodeled viewer-test endpoint" }),
    });
  });

  await page.goto("/?echo-ui-shell-v2=1&echoWebDiagnosticsCanary=1#canary-check", {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator("#diagnostics-consent-modal")).toBeVisible();
  await page.getByRole("button", { name: "Allow Diagnostics" }).click();
  await expect(page.locator("#diagnostics-action-status")).toHaveText("Diagnostics are on.");

  const decidedUrl = new URL(page.url());
  expect(decidedUrl.searchParams.has("echoWebDiagnosticsCanary")).toBe(false);
  expect(decidedUrl.searchParams.get("echo-ui-shell-v2")).toBe("1");
  expect(decidedUrl.hash).toBe("#canary-check");
  expect(diagnosticsState(await readStorage(page))[CONSENT_KEY]).toBe("enabled-v1");

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#diagnostics-consent-modal")).toBeHidden();
  await expect(page.locator("#diagnostics-settings-section")).not.toHaveClass(/\bhidden\b/);
  await expect(page.locator("#diagnostics-enabled-toggle")).toBeChecked();
  await expect.poll(() => page.evaluate(() => (
    window.EchoWebDiagnosticsRuntime?.consentState()
  ))).toBe("enabled");
});
