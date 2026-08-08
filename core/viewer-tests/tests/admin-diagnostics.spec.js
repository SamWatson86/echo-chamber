import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

const OWNER_SECRET = "correct horse battery staple owner secret!";
const OWNER_TOKEN = "diagnostics-owner-token.header.signature";
const HOSTILE_IDENTITY = '<img src=x onerror="window.__echoXss=1"><script>window.__echoXss=2</script>';
const HOSTILE_DETAIL = '<img src=x onerror="window.__echoXss=3"><script>window.__echoXss=4</script>';
const BASE_TIME = 1_753_110_000_000;

function incidentId(index) {
  return `inc_${index.toString(16).padStart(32, "0")}`;
}

function uuid(index) {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function summary(index, overrides = {}) {
  return {
    incident_id: incidentId(index),
    envelope_id: uuid(index),
    authenticated_identity: `identity-${index.toString().padStart(4, "0")}`,
    received_at_ms: BASE_TIME - (index * 1_000),
    captured_at_ms: BASE_TIME - (index * 1_000) - 500,
    session_id: uuid(index + 1_000),
    app_version: "0.6.33",
    channel: "web-canary",
    client_kind: "browser",
    operating_system: "macos",
    architecture: "aarch64",
    event_count: 1,
    highest_severity: "warning",
    event_types: ["connection"],
    ...overrides,
  };
}

function storedIncident(item, overrides = {}) {
  return {
    record_version: 1,
    incident_id: item.incident_id,
    received_at_ms: item.received_at_ms,
    authenticated_identity: item.authenticated_identity,
    authenticated_identity_digest: "identity-hmac-must-never-render",
    payload_digest: "payload-digest-must-never-render",
    envelope: {
      schema_version: 1,
      envelope_id: item.envelope_id,
      install_id: uuid(8_000),
      session_id: item.session_id,
      captured_at_ms: item.captured_at_ms,
      sent_at_ms: item.captured_at_ms + 100,
      app: {
        version: item.app_version,
        git_sha: "abcdef123456",
        channel: item.channel,
        runtimes: {
          browser_name: "Safari",
          browser_version: "18.5",
        },
      },
      platform: {
        client_kind: item.client_kind,
        operating_system: item.operating_system,
        architecture: item.architecture,
      },
      events: [{
        sequence: 1,
        timestamp_ms: item.captured_at_ms,
        event_type: item.event_types[0],
        severity: item.highest_severity,
        code: "connection.failed",
        fingerprint: "fingerprint-must-never-render",
        message: "raw-message-must-never-render",
        details: { state: HOSTILE_DETAIL },
      }],
    },
    ...overrides,
  };
}

async function fulfillJson(route, status, body, headers = {}) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store", ...headers },
    body: JSON.stringify(body),
  });
}

async function installApiMock(page, handlers = {}) {
  await page.route("**/v1/auth/diagnostics/login", async (route) => {
    if (handlers.login) {
      await handlers.login(route);
      return;
    }
    await fulfillJson(route, 200, {
      ok: true,
      token: OWNER_TOKEN,
      expires_in_seconds: 3_600,
    });
  });

  await page.route("**/admin/api/diagnostics**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/admin/api/diagnostics") {
      if (handlers.list) {
        await handlers.list(route, url);
      } else {
        await fulfillJson(route, 200, { incidents: [] });
      }
      return;
    }
    if (path.endsWith("/download")) {
      if (handlers.download) {
        await handlers.download(route, url);
      } else {
        await route.fulfill({ status: 404, body: "" });
      }
      return;
    }
    if (request.method() === "DELETE") {
      if (handlers.delete) {
        await handlers.delete(route, url);
      } else {
        await route.fulfill({ status: 404, body: "" });
      }
      return;
    }
    if (handlers.detail) {
      await handlers.detail(route, url);
    } else {
      await route.fulfill({ status: 404, body: "" });
    }
  });
}

async function openAndLogin(page, secret = OWNER_SECRET) {
  await page.goto("/admin/diagnostics/", { waitUntil: "domcontentloaded" });
  await page.locator("#owner-secret").fill(secret);
  await page.locator("#login-form").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#dashboard-view")).toBeVisible();
  await expect(page.locator("#login-view")).toBeHidden();
}

function expectOpaqueBoundedStatus(locator) {
  return Promise.all([
    expect(locator).not.toContainText("SERVER_BODY_MUST_STAY_OPAQUE"),
    expect(locator).toContainText(/try again|too many|rate limit/i),
    expect.poll(async () => (await locator.textContent())?.length || 0).toBeLessThan(200),
  ]);
}

test("owner diagnostics source bans injection sinks and browser persistence APIs", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../../admin/diagnostics/index.html", import.meta.url), "utf8"),
    readFile(new URL("../../admin/diagnostics/diagnostics.js", import.meta.url), "utf8"),
  ]);
  const source = `${html}\n${script}`;

  expect(source).not.toMatch(/\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/);
  expect(source).not.toMatch(/document\s*\.\s*write(?:ln)?\s*\(/);
  expect(source).not.toMatch(/\beval\s*\(/);
  expect(source).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB)\b/);
  expect(source).not.toMatch(/window\s*\.\s*name\b/);
  expect(script).not.toMatch(/\bconsole\s*\./);
  expect(html).toContain('<meta http-equiv="Content-Security-Policy"');
  expect(html).not.toMatch(/<script\b(?![^>]*\bsrc\s*=)[^>]*>/i);
  expect(html).not.toMatch(/\s(?:style|on[a-z]+)\s*=/i);
  for (const functionName of ["closeDetail", "loadDetail", "downloadSelected", "deleteSelected"]) {
    const declarations = script.match(new RegExp(`function\\s+${functionName}\\s*\\(`, "g")) || [];
    expect(declarations, `${functionName} must have one implementation`).toHaveLength(1);
  }
});

test("test server keeps admin assets isolated while preserving the viewer root", async ({ request }) => {
  const [viewer, diagnostics, escapedAdmin] = await Promise.all([
    request.get("/"),
    request.get("/admin/diagnostics/"),
    request.get("/admin/%2e%2e%2fviewer/index.html"),
  ]);

  expect(viewer.status()).toBe(200);
  expect(await viewer.text()).toContain("Echo Chamber");
  expect(diagnostics.status()).toBe(200);
  expect(await diagnostics.text()).toContain("Private Diagnostics");
  expect(escapedAdmin.status()).toBe(403);
});

test("a blocked diagnostics script cannot serialize the owner secret into a request or URL", async ({
  baseURL,
  page,
}) => {
  const observedRequests = [];
  page.on("request", (request) => {
    observedRequests.push({ body: request.postData() || "", url: request.url() });
  });
  await page.route("**/admin/diagnostics/diagnostics.js", (route) => route.abort());
  await page.goto("/admin/diagnostics/", { waitUntil: "domcontentloaded" });
  await page.locator("#owner-secret").fill(OWNER_SECRET);

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    page.locator("#login-button").click(),
  ]);

  const finalUrl = new URL(page.url());
  expect(`${finalUrl.origin}${finalUrl.pathname}`).toBe(
    new URL("/admin/diagnostics/", baseURL).href,
  );
  expect([...finalUrl.searchParams]).toHaveLength(0);
  expect(finalUrl.hash).toBe("");
  expect(JSON.stringify(observedRequests)).not.toContain(OWNER_SECRET);
  await expect(page.locator("#owner-secret")).toHaveValue("");
});

test("credentials stay memory-only, exact, omitted from cookies, and clear on lifecycle boundaries", async ({
  baseURL,
  page,
}) => {
  const loginBodies = [];
  const listRequests = [];

  await page.context().addCookies([{
    name: "unrelated-cookie",
    value: "must-not-be-sent",
    url: new URL("/", baseURL).href,
  }]);
  await installApiMock(page, {
    login: async (route) => {
      const request = route.request();
      loginBodies.push(request.postDataJSON());
      expect(request.headers().cookie).toBeUndefined();
      expect(request.headers().authorization).toBeUndefined();
      await fulfillJson(route, 200, {
        ok: true,
        token: OWNER_TOKEN,
        expires_in_seconds: 3_600,
      });
    },
    list: async (route) => {
      const request = route.request();
      listRequests.push(request.url());
      expect(request.headers().authorization).toBe(`Bearer ${OWNER_TOKEN}`);
      expect(request.headers().cookie).toBeUndefined();
      await fulfillJson(route, 200, { incidents: [] });
    },
  });

  await openAndLogin(page);
  expect(loginBodies).toEqual([{ secret: OWNER_SECRET }]);
  await expect(page.locator("#owner-secret")).toHaveValue("");
  expect(listRequests).toHaveLength(1);

  const persisted = await page.evaluate(async () => ({
    cookie: document.cookie,
    databases: typeof indexedDB.databases === "function"
      ? (await indexedDB.databases()).map((database) => database.name)
      : [],
    href: location.href,
    local: { ...localStorage },
    name: window.name,
    session: { ...sessionStorage },
  }));
  expect(JSON.stringify(persisted)).not.toContain(OWNER_SECRET);
  expect(JSON.stringify(persisted)).not.toContain(OWNER_TOKEN);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#login-view")).toBeVisible();
  await expect(page.locator("#dashboard-view")).toBeHidden();
  await expect(page.locator("#owner-secret")).toHaveValue("");
  expect(listRequests).toHaveLength(1);

  await openAndLogin(page);
  expect(listRequests).toHaveLength(2);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
  });
  await expect(page.locator("#login-view")).toBeVisible();
  await expect(page.locator("#dashboard-view")).toBeHidden();
});

test("hostile summary and detail strings render literally while private fields remain hidden", async ({
  page,
}) => {
  const item = summary(1, { authenticated_identity: HOSTILE_IDENTITY });
  await installApiMock(page, {
    list: async (route) => {
      expect(route.request().headers().authorization).toBe(`Bearer ${OWNER_TOKEN}`);
      await fulfillJson(route, 200, { incidents: [item] });
    },
    detail: async (route) => {
      expect(route.request().headers().authorization).toBe(`Bearer ${OWNER_TOKEN}`);
      await fulfillJson(route, 200, storedIncident(item));
    },
  });

  await openAndLogin(page);
  await expect(page.locator("#incident-rows")).toContainText(HOSTILE_IDENTITY);
  await expect(page.locator("#incident-rows img, #incident-rows script")).toHaveCount(0);
  await page.locator("#incident-rows button").first().click();

  await expect(page.locator("#detail-panel")).toBeVisible();
  await expect(page.locator("#detail-content")).toContainText("<img src=x onerror=");
  await expect(page.locator("#detail-content")).toContainText(
    "<script>window.__echoXss=4</script>",
  );
  await expect(page.locator("#detail-content img, #detail-content script")).toHaveCount(0);
  await expect(page.locator("#detail-content")).not.toContainText("identity-hmac-must-never-render");
  await expect(page.locator("#detail-content")).not.toContainText("payload-digest-must-never-render");
  await expect(page.locator("#detail-content")).not.toContainText("raw-message-must-never-render");
  await expect(page.locator("#detail-content")).not.toContainText("fingerprint-must-never-render");
  expect(await page.evaluate(() => window.__echoXss)).toBeUndefined();
});

test("detail actions stay disabled until a matching detail is verified and disable again on close", async ({
  page,
}) => {
  const item = summary(4);
  const firstDetail = deferred();
  const secondDetail = deferred();
  const gates = [firstDetail, secondDetail];
  let detailRequests = 0;
  await installApiMock(page, {
    list: async (route) => fulfillJson(route, 200, { incidents: [item] }),
    detail: async (route) => {
      const attempt = detailRequests;
      detailRequests += 1;
      await gates[attempt].promise;
      if (attempt === 0) {
        await fulfillJson(route, 200, storedIncident(summary(999)));
      } else {
        await fulfillJson(route, 200, storedIncident(item));
      }
    },
  });

  await openAndLogin(page);
  await expect(page.locator("#download-button")).toBeDisabled();
  await expect(page.locator("#delete-button")).toBeDisabled();

  await page.locator("#incident-rows button").click();
  await expect.poll(() => detailRequests).toBe(1);
  await expect(page.locator("#download-button")).toBeDisabled();
  await expect(page.locator("#delete-button")).toBeDisabled();
  firstDetail.resolve();
  await expect(page.locator("#detail-status")).toContainText(/could not be verified/i);
  await expect(page.locator("#download-button")).toBeDisabled();
  await expect(page.locator("#delete-button")).toBeDisabled();

  await page.locator("#incident-rows button").click();
  await expect.poll(() => detailRequests).toBe(2);
  await expect(page.locator("#download-button")).toBeDisabled();
  secondDetail.resolve();
  await expect(page.locator("#download-button")).toBeEnabled();
  await expect(page.locator("#delete-button")).toBeEnabled();
  await expect(page.locator("#detail-title")).toBeFocused();

  await page.locator("#close-detail-button").click();
  await expect(page.locator("#detail-panel")).toBeHidden();
  await expect(page.locator("#download-button")).toBeDisabled();
  await expect(page.locator("#delete-button")).toBeDisabled();
  await expect(page.locator("#incident-rows button")).toBeFocused();
});

test("pagehide erases private DOM and fences a late incident response", async ({ page }) => {
  const item = summary(5, { authenticated_identity: "identity-must-be-erased" });
  await page.addInitScript((lateItem) => {
    const originalFetch = window.fetch.bind(window);
    window.__lateListStarted = false;
    window.fetch = function (input, options) {
      const rawUrl = typeof input === "string" ? input : input.url;
      const url = new URL(rawUrl, location.href);
      if (url.pathname !== "/admin/api/diagnostics") return originalFetch(input, options);
      window.__lateListStarted = true;
      return new Promise((resolve) => {
        window.__resolveLateList = () => resolve(new Response(
          JSON.stringify({ incidents: [lateItem] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ));
      });
    };
  }, item);
  await installApiMock(page, {
    list: async (route) => fulfillJson(route, 500, { unexpected: true }),
  });

  await page.goto("/admin/diagnostics/", { waitUntil: "domcontentloaded" });
  await page.locator("#owner-secret").fill(OWNER_SECRET);
  await page.locator("#login-form").evaluate((form) => form.requestSubmit());
  await expect.poll(() => page.evaluate(() => window.__lateListStarted)).toBe(true);
  await expect(page.locator("#dashboard-view")).toBeVisible();
  await page.locator("#search-filter").fill("private-search-must-be-erased");

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
  });
  await page.evaluate(() => window.__resolveLateList());
  await page.waitForTimeout(50);

  await expect(page.locator("#login-view")).toBeVisible();
  await expect(page.locator("#dashboard-view")).toBeHidden();
  await expect(page.locator("#incident-rows tr")).toHaveCount(0);
  await expect(page.locator("#search-filter")).toHaveValue("");
  await expect(page.locator("#detail-title")).toHaveText("Selected incident");
  await expect(page.locator("body")).not.toContainText("identity-must-be-erased");
});

test("token expiry ends the session and erases the private view", async ({ page }) => {
  const item = summary(6, { authenticated_identity: "expiry-private-identity" });
  await installApiMock(page, {
    login: async (route) => fulfillJson(route, 200, {
      ok: true,
      token: OWNER_TOKEN,
      expires_in_seconds: 1,
    }),
    list: async (route) => fulfillJson(route, 200, { incidents: [item] }),
  });

  await openAndLogin(page);
  await expect(page.locator("#incident-rows")).toContainText("expiry-private-identity");
  await page.locator("#search-filter").fill("expiry-private-identity");

  await expect(page.locator("#login-view")).toBeVisible({ timeout: 3_000 });
  await expect(page.locator("#dashboard-view")).toBeHidden();
  await expect(page.locator("#login-status")).toContainText(/session expired/i);
  await expect(page.locator("#incident-rows tr")).toHaveCount(0);
  await expect(page.locator("#search-filter")).toHaveValue("");
  await expect(page.locator("#owner-secret")).toBeFocused();
});

test("fetches 51, renders 50, paginates with the displayed cursor, and restores Previous in memory", async ({
  page,
}) => {
  const firstPage = Array.from({ length: 51 }, (_, index) => summary(index + 1));
  const secondPage = [summary(100), summary(101)];
  const listUrls = [];

  await installApiMock(page, {
    list: async (route, url) => {
      listUrls.push(url);
      expect(url.searchParams.get("limit")).toBe("51");
      const hasCursor = url.searchParams.has("before_received_at_ms");
      await fulfillJson(route, 200, { incidents: hasCursor ? secondPage : firstPage });
    },
  });

  await openAndLogin(page);
  await expect(page.locator("#incident-rows tr")).toHaveCount(50);
  await expect(page.locator("#incident-rows button").first()).toHaveAttribute(
    "aria-label",
    "View details for incident 00000001",
  );
  await expect(page.locator("#incident-rows button").nth(1)).toHaveAttribute(
    "aria-label",
    "View details for incident 00000002",
  );
  await expect(page.locator("#page-label")).toHaveText("Page 1");
  await expect(page.locator("#previous-button")).toBeDisabled();
  await expect(page.locator("#next-button")).toBeEnabled();

  await page.locator("#next-button").click();
  await expect(page.locator("#incident-rows tr")).toHaveCount(2);
  await expect(page.locator("#page-label")).toHaveText("Page 2");
  expect(listUrls).toHaveLength(2);
  expect(listUrls[1].searchParams.get("before_received_at_ms")).toBe(
    String(firstPage[49].received_at_ms),
  );
  expect(listUrls[1].searchParams.get("before_incident_id")).toBe(firstPage[49].incident_id);

  await page.locator("#previous-button").click();
  await expect(page.locator("#incident-rows tr")).toHaveCount(50);
  await expect(page.locator("#page-label")).toHaveText("Page 1");
  expect(listUrls).toHaveLength(2);
});

test("a late Next response cannot overwrite a newer Previous navigation", async ({ page }) => {
  const firstPage = Array.from({ length: 51 }, (_, index) => summary(index + 1));
  const secondPage = Array.from({ length: 51 }, (_, index) => summary(index + 101));
  const thirdPage = [summary(301)];
  const thirdStarted = deferred();
  const releaseThird = deferred();
  const thirdFulfilled = deferred();
  let listRequests = 0;
  await installApiMock(page, {
    list: async (route) => {
      listRequests += 1;
      if (listRequests === 1) {
        await fulfillJson(route, 200, { incidents: firstPage });
      } else if (listRequests === 2) {
        await fulfillJson(route, 200, { incidents: secondPage });
      } else {
        thirdStarted.resolve();
        await releaseThird.promise;
        await fulfillJson(route, 200, { incidents: thirdPage });
        thirdFulfilled.resolve();
      }
    },
  });

  await openAndLogin(page);
  await page.locator("#next-button").click();
  await expect(page.locator("#page-label")).toHaveText("Page 2");
  await expect(page.locator("#previous-button")).toBeEnabled();

  await page.locator("#next-button").click();
  await thirdStarted.promise;
  await page.locator("#previous-button").click();
  await expect(page.locator("#page-label")).toHaveText("Page 1");
  await expect(page.locator("#previous-button")).toBeDisabled();

  releaseThird.resolve();
  await thirdFulfilled.promise;
  await page.waitForTimeout(50);
  await expect(page.locator("#page-label")).toHaveText("Page 1");
  await expect(page.locator("#incident-rows")).toContainText(firstPage[0].authenticated_identity);
  await expect(page.locator("#incident-rows")).not.toContainText(thirdPage[0].authenticated_identity);
  await expect(page.locator("#previous-button")).toBeDisabled();
  expect(listRequests).toBe(3);
});

test("identity, OS, severity, and event filters affect only the loaded page", async ({ page }) => {
  const incidents = [
    summary(1, {
      authenticated_identity: "mac-error-person",
      highest_severity: "error",
      event_types: ["connection"],
    }),
    summary(2, {
      authenticated_identity: "unique-windows-person",
      operating_system: "windows",
      architecture: "x86_64",
      highest_severity: "info",
      event_types: ["media"],
    }),
    summary(3, {
      authenticated_identity: "mac-fatal-person",
      highest_severity: "fatal",
      event_types: ["javascript_error"],
    }),
  ];
  let listRequests = 0;
  await installApiMock(page, {
    list: async (route) => {
      listRequests += 1;
      await fulfillJson(route, 200, { incidents });
    },
  });

  await openAndLogin(page);
  await expect(page.locator("#incident-rows tr")).toHaveCount(3);

  await page.locator("#search-filter").fill("web-canary");
  await expect(page.locator("#incident-rows tr")).toHaveCount(0);
  await page.locator("#search-filter").fill("unique-windows");
  await expect(page.locator("#incident-rows tr")).toHaveCount(1);
  await page.locator("#search-filter").fill("");

  await page.locator("#os-filter").selectOption("macos");
  await expect(page.locator("#incident-rows tr")).toHaveCount(2);
  await page.locator("#severity-filter").selectOption("fatal");
  await expect(page.locator("#incident-rows tr")).toHaveCount(1);
  await page.locator("#event-filter").selectOption("javascript_error");
  await expect(page.locator("#incident-rows tr")).toHaveCount(1);

  await page.locator("#clear-filters-button").click();
  await expect(page.locator("#incident-rows tr")).toHaveCount(3);
  expect(listRequests).toBe(1);
});

test("401 logs out and disabled or rate-limited endpoints expose only bounded status", async ({ page }) => {
  let listStatus = 200;
  await installApiMock(page, {
    list: async (route) => {
      if (listStatus === 200) {
        await fulfillJson(route, 200, { incidents: [] });
      } else {
        await route.fulfill({
          status: listStatus,
          headers: { "Retry-After": "999999" },
          body: "SERVER_BODY_MUST_STAY_OPAQUE",
        });
      }
    },
  });

  await openAndLogin(page);
  listStatus = 429;
  await page.locator("#refresh-button").click();
  await expectOpaqueBoundedStatus(page.locator("#dashboard-status"));

  listStatus = 401;
  await page.locator("#refresh-button").click();
  await expect(page.locator("#login-view")).toBeVisible();
  await expect(page.locator("#dashboard-view")).toBeHidden();
  await expect(page.locator("#login-status")).not.toContainText("SERVER_BODY_MUST_STAY_OPAQUE");
});

for (const endpoint of ["login", "list"]) {
  test(`${endpoint} 404 reports that private diagnostics are disabled`, async ({ page }) => {
    await installApiMock(page, {
      login: async (route) => {
        if (endpoint === "login") {
          await route.fulfill({ status: 404, body: "SERVER_BODY_MUST_STAY_OPAQUE" });
        } else {
          await fulfillJson(route, 200, {
            ok: true,
            token: OWNER_TOKEN,
            expires_in_seconds: 3_600,
          });
        }
      },
      list: async (route) => {
        await route.fulfill({
          status: endpoint === "list" ? 404 : 200,
          contentType: "application/json",
          body: endpoint === "list"
            ? "SERVER_BODY_MUST_STAY_OPAQUE"
            : JSON.stringify({ incidents: [] }),
        });
      },
    });

    await page.goto("/admin/diagnostics/", { waitUntil: "domcontentloaded" });
    await page.locator("#owner-secret").fill(OWNER_SECRET);
    await page.locator("#login-form").evaluate((form) => form.requestSubmit());
    await expect(page.locator("#login-view")).toBeVisible();
    await expect(page.locator("#login-status")).toContainText(/not available|not enabled|disabled/i);
    await expect(page.locator("#login-status")).not.toContainText("SERVER_BODY_MUST_STAY_OPAQUE");
  });
}

test("login 429 exposes a bounded opaque retry message", async ({ page }) => {
  await installApiMock(page, {
    login: async (route) => {
      await route.fulfill({
        status: 429,
        headers: { "Retry-After": "999999" },
        body: "SERVER_BODY_MUST_STAY_OPAQUE",
      });
    },
  });

  await page.goto("/admin/diagnostics/", { waitUntil: "domcontentloaded" });
  await page.locator("#owner-secret").fill(OWNER_SECRET);
  await page.locator("#login-form").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#login-view")).toBeVisible();
  await expectOpaqueBoundedStatus(page.locator("#login-status"));
});

test("download is authenticated, uses a local safe filename, and revokes its blob URL", async ({
  page,
}) => {
  const item = summary(42);
  const downloadRequests = [];
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    window.__blobUrlAudit = { created: [], revoked: [] };
    URL.createObjectURL = (blob) => {
      const value = create(blob);
      window.__blobUrlAudit.created.push(value);
      return value;
    };
    URL.revokeObjectURL = (value) => {
      window.__blobUrlAudit.revoked.push(value);
      revoke(value);
    };
  });
  await installApiMock(page, {
    list: async (route) => fulfillJson(route, 200, { incidents: [item] }),
    detail: async (route) => fulfillJson(route, 200, storedIncident(item)),
    download: async (route) => {
      downloadRequests.push(route.request());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "Content-Disposition": 'attachment; filename="../../hostile<script>.json"',
        },
        body: JSON.stringify({ incident_id: item.incident_id, redacted: true }),
      });
    },
  });

  await openAndLogin(page);
  await page.locator("#incident-rows button").first().click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#download-button").click();
  const download = await downloadPromise;

  expect(downloadRequests).toHaveLength(1);
  expect(downloadRequests[0].headers().authorization).toBe(`Bearer ${OWNER_TOKEN}`);
  expect(downloadRequests[0].headers().cookie).toBeUndefined();
  expect(download.suggestedFilename()).toBe(`echo-diagnostic-${item.incident_id}.json`);
  await expect.poll(() => page.evaluate(() => window.__blobUrlAudit)).toEqual({
    created: [expect.stringMatching(/^blob:/)],
    revoked: [expect.stringMatching(/^blob:/)],
  });
  const audit = await page.evaluate(() => window.__blobUrlAudit);
  expect(audit.revoked).toEqual(audit.created);
});

test("download ceiling rejects oversized streams with absent or lying Content-Length", async ({
  page,
}) => {
  const item = summary(43);
  const downloads = [];
  page.on("download", (download) => downloads.push(download));
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.__diagnosticsLengthMode = "absent";
    window.__downloadStreamAudits = [];
    window.fetch = function (input, options) {
      const rawUrl = typeof input === "string" ? input : input.url;
      const url = new URL(rawUrl, location.href);
      if (!url.pathname.endsWith("/download")) return originalFetch(input, options);

      const audit = {
        cancelled: false,
        mode: window.__diagnosticsLengthMode,
        pulls: 0,
      };
      window.__downloadStreamAudits.push(audit);
      const body = new ReadableStream({
        pull(controller) {
          audit.pulls += 1;
          if (audit.pulls <= 100) {
            controller.enqueue(new Uint8Array(64 * 1024));
          } else {
            controller.close();
          }
        },
        cancel() {
          audit.cancelled = true;
        },
      });
      const headers = { "Content-Type": "application/json" };
      if (window.__diagnosticsLengthMode === "lying") headers["Content-Length"] = "1";
      if (window.__diagnosticsLengthMode === "declared-oversize") {
        headers["Content-Length"] = String(1024 * 1024);
      }
      return Promise.resolve(new Response(body, { status: 200, headers }));
    };
  });
  await installApiMock(page, {
    list: async (route) => fulfillJson(route, 200, { incidents: [item] }),
    detail: async (route) => fulfillJson(route, 200, storedIncident(item)),
  });

  await openAndLogin(page);
  await page.locator("#incident-rows button").click();
  await expect(page.locator("#download-button")).toBeEnabled();

  await page.locator("#download-button").click();
  await expect(page.locator("#download-button")).toBeEnabled();
  await expect(page.locator("#detail-status")).toContainText(/temporarily unavailable|safe browser limit/i);
  expect(downloads).toHaveLength(0);
  await expect.poll(() => page.evaluate(() => window.__downloadStreamAudits[0])).toMatchObject({
    cancelled: true,
    mode: "absent",
  });
  expect(await page.evaluate(() => window.__downloadStreamAudits[0].pulls)).toBeLessThan(20);

  await page.evaluate(() => { window.__diagnosticsLengthMode = "lying"; });
  await page.locator("#download-button").click();
  await expect(page.locator("#download-button")).toBeEnabled();
  await expect(page.locator("#detail-status")).toContainText(/temporarily unavailable|safe browser limit/i);
  expect(downloads).toHaveLength(0);
  await expect.poll(() => page.evaluate(() => window.__downloadStreamAudits[1])).toMatchObject({
    cancelled: true,
    mode: "lying",
  });
  expect(await page.evaluate(() => window.__downloadStreamAudits[1].pulls)).toBeLessThan(20);

  await page.evaluate(() => { window.__diagnosticsLengthMode = "declared-oversize"; });
  await page.locator("#download-button").click();
  await expect(page.locator("#download-button")).toBeEnabled();
  expect(downloads).toHaveLength(0);
  await expect.poll(() => page.evaluate(() => window.__downloadStreamAudits[2])).toMatchObject({
    cancelled: true,
    mode: "declared-oversize",
  });
  expect(await page.evaluate(() => window.__downloadStreamAudits[2].pulls)).toBeLessThan(3);
});

test("delete cancellation sends nothing and confirmed 204 refreshes the current page", async ({
  page,
}) => {
  const item = summary(7);
  let deleteRequests = 0;
  let listRequests = 0;
  await installApiMock(page, {
    list: async (route) => {
      listRequests += 1;
      await fulfillJson(route, 200, { incidents: listRequests === 1 ? [item] : [] });
    },
    detail: async (route) => fulfillJson(route, 200, storedIncident(item)),
    delete: async (route) => {
      deleteRequests += 1;
      expect(route.request().headers().authorization).toBe(`Bearer ${OWNER_TOKEN}`);
      await route.fulfill({ status: 204, body: "" });
    },
  });

  await openAndLogin(page);
  await page.locator("#incident-rows button").first().click();
  await expect(page.locator("#detail-panel")).toBeVisible();

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#delete-button").click();
  expect(deleteRequests).toBe(0);
  expect(listRequests).toBe(1);

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#delete-button").click();
  await expect(page.locator("#incident-rows tr")).toHaveCount(0);
  await expect(page.locator("#detail-panel")).toBeHidden();
  await expect(page.locator("#results-summary")).toBeFocused();
  expect(deleteRequests).toBe(1);
  expect(listRequests).toBe(2);
});

test("a confirmed delete stays removed locally when the follow-up refresh fails", async ({ page }) => {
  const item = summary(8);
  let listRequests = 0;
  await installApiMock(page, {
    list: async (route) => {
      listRequests += 1;
      if (listRequests === 1) {
        await fulfillJson(route, 200, { incidents: [item] });
      } else {
        await route.fulfill({ status: 500, body: "SERVER_BODY_MUST_STAY_OPAQUE" });
      }
    },
    detail: async (route) => fulfillJson(route, 200, storedIncident(item)),
    delete: async (route) => route.fulfill({ status: 204, body: "" }),
  });

  await openAndLogin(page);
  await page.locator("#incident-rows button").click();
  await expect(page.locator("#delete-button")).toBeEnabled();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#delete-button").click();

  await expect(page.locator("#incident-rows tr")).toHaveCount(0);
  await expect(page.locator("#detail-panel")).toBeHidden();
  await expect(page.locator("#results-summary")).toBeFocused();
  await expect(page.locator("#dashboard-status")).toContainText(/temporarily unavailable/i);
  await expect(page.locator("#dashboard-status")).not.toContainText("SERVER_BODY_MUST_STAY_OPAQUE");
  expect(listRequests).toBe(2);
});
