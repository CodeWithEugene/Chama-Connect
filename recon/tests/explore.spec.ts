import { test, expect, Page, Request, Response } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

/**
 * Deep recon of chamaconnect.io:
 *  1) Log in with the .env credentials
 *  2) Crawl the authenticated dashboard, taking screenshots
 *  3) Record every XHR/fetch request + response (URL, status, payload shape)
 *  4) Snapshot every distinct route's HTML for later grep
 *
 * Outputs go to ./artifacts/<timestamp>/ so we keep an audit trail.
 */

const EMAIL = process.env.email ?? process.env.EMAIL;
const PASSWORD = process.env.password ?? process.env.PASSWORD;

if (!EMAIL || !PASSWORD) {
  throw new Error(
    "Recon needs email + password in root .env (keys: email, password)"
  );
}

const RUN_DIR = path.resolve(
  __dirname,
  "..",
  "artifacts",
  new Date().toISOString().replace(/[:.]/g, "-")
);
fs.mkdirSync(path.join(RUN_DIR, "screenshots"), { recursive: true });
fs.mkdirSync(path.join(RUN_DIR, "html"), { recursive: true });
fs.mkdirSync(path.join(RUN_DIR, "network"), { recursive: true });

type NetEntry = {
  method: string;
  url: string;
  status: number | null;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseHeaders: Record<string, string>;
  responseBody: string | null;
  timing: number;
  resourceType: string;
  fromPage: string;
};

const networkLog: NetEntry[] = [];
const pageVisitsFile = path.join(RUN_DIR, "visits.json");
const visits: Array<{ url: string; title: string; ts: string }> = [];
const consoleMessages: Array<{ type: string; text: string; page: string }> = [];
const pageErrors: Array<{ message: string; page: string }> = [];

const sanitize = (s: string) =>
  s.replace(/https?:\/\//, "").replace(/[^a-z0-9]/gi, "_").slice(0, 80);

async function instrument(page: Page) {
  page.on("console", (msg) => {
    consoleMessages.push({
      type: msg.type(),
      text: msg.text(),
      page: page.url(),
    });
  });
  page.on("pageerror", (err) => {
    pageErrors.push({ message: err.message, page: page.url() });
  });
  page.on("requestfinished", async (req: Request) => {
    const rt = req.resourceType();
    if (!["xhr", "fetch", "document"].includes(rt)) return;
    const resp: Response | null = await req.response();
    const timing = req.timing();
    let reqBody: string | null = null;
    try {
      reqBody = req.postData() ?? null;
    } catch {}
    let respBody: string | null = null;
    let status: number | null = null;
    let respHeaders: Record<string, string> = {};
    if (resp) {
      status = resp.status();
      respHeaders = await resp.headers();
      const ct = (respHeaders["content-type"] || "").toLowerCase();
      if (
        ct.includes("json") ||
        ct.includes("text") ||
        ct.includes("html") ||
        ct.includes("javascript")
      ) {
        try {
          const buf = await resp.body();
          if (buf.length < 200_000) {
            respBody = buf.toString("utf8");
          } else {
            respBody = `<<<${buf.length} bytes truncated>>>`;
          }
        } catch {}
      }
    }
    networkLog.push({
      method: req.method(),
      url: req.url(),
      status,
      requestHeaders: await req.allHeaders(),
      requestBody: reqBody,
      responseHeaders: respHeaders,
      responseBody: respBody,
      timing: timing.responseEnd,
      resourceType: rt,
      fromPage: page.url(),
    });
  });
  page.on("requestfailed", (req) => {
    networkLog.push({
      method: req.method(),
      url: req.url(),
      status: null,
      requestHeaders: {},
      requestBody: null,
      responseHeaders: { failure: req.failure()?.errorText ?? "unknown" },
      responseBody: null,
      timing: 0,
      resourceType: req.resourceType(),
      fromPage: page.url(),
    });
  });
}

async function capture(page: Page, label: string) {
  const url = page.url();
  const tag = `${label}__${sanitize(url)}`;
  try {
    await page.screenshot({
      path: path.join(RUN_DIR, "screenshots", `${tag}.png`),
      fullPage: true,
    });
  } catch (e) {
    console.warn(`screenshot failed for ${url}: ${(e as Error).message}`);
  }
  try {
    const html = await page.content();
    fs.writeFileSync(path.join(RUN_DIR, "html", `${tag}.html`), html);
  } catch (e) {
    console.warn(`html capture failed for ${url}: ${(e as Error).message}`);
  }
  const title = await page.title().catch(() => "");
  visits.push({ url, title, ts: new Date().toISOString() });
}

test("deep recon of chamaconnect.io", async ({ page }) => {
  test.setTimeout(10 * 60 * 1000); // 10 min budget
  await instrument(page);

  console.log(`[recon] artifacts → ${RUN_DIR}`);
  console.log(`[recon] login as ${EMAIL}`);

  // 1) Public pages first, so we have metadata bug evidence captured on login.
  // Wrap in try/catch — some routes (/terms) have been observed to hang; do not fail the whole run.
  for (const pub of ["/", "/features", "/pricing", "/about", "/faqs", "/contact", "/onboard-chama", "/community", "/terms"]) {
    try {
      await page.goto(pub, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.waitForTimeout(800);
      await capture(page, `public${pub.replace(/\//g, "_") || "_home"}`);
    } catch (e) {
      console.warn(`[recon] skipping ${pub}: ${(e as Error).message}`);
    }
  }

  // 2) Login — real flow is POST /api/proxy/users/signin → /api/auth/session → dashboard
  try {
    await page.goto("/get-started", { waitUntil: "domcontentloaded", timeout: 20_000 });
  } catch (e) {
    console.warn(`[recon] /get-started nav: ${(e as Error).message}`);
  }
  // Allow the login bundle to hydrate
  await page.waitForTimeout(1500);
  await capture(page, "login_before");
  await page.locator('input[type="email"]').first().fill(EMAIL!);
  await page.locator('input[type="password"]').first().fill(PASSWORD!);
  await capture(page, "login_filled");

  // Click and wait for the real signin POST to resolve
  const signinPromise = page
    .waitForResponse(
      (r) => r.url().includes("/api/proxy/users/signin") && r.request().method() === "POST",
      { timeout: 30_000 }
    )
    .catch(() => null);
  const loginBtn = page
    .getByRole("button", { name: /log\s*in|sign\s*in|continue/i })
    .first();
  await loginBtn.click();
  const signinResp = await signinPromise;
  if (signinResp) {
    const status = signinResp.status();
    let body = "";
    try { body = await signinResp.text(); } catch {}
    console.log(`[recon] signin POST → ${status} · body[0..200]=${body.slice(0, 200)}`);
    fs.writeFileSync(path.join(RUN_DIR, "signin_response.json"), JSON.stringify({ status, body }, null, 2));
  } else {
    console.warn("[recon] never saw /api/proxy/users/signin");
  }

  // Also wait for session cookie sync
  await page
    .waitForResponse(
      (r) => r.url().includes("/api/auth/session") && r.request().method() === "POST",
      { timeout: 10_000 }
    )
    .catch(() => null);
  // Wait for client-side redirect away from /get-started
  await page
    .waitForURL((u) => !u.toString().endsWith("/get-started"), { timeout: 15_000 })
    .catch(() => null);
  await page.waitForTimeout(1500);
  await capture(page, "login_after");
  console.log(`[recon] post-login url: ${page.url()}`);

  // 3) If we're still on /get-started after login, try well-known dashboard routes
  let landing = page.url();
  if (landing.endsWith("/get-started") || landing.endsWith("/login")) {
    for (const candidate of ["/dashboard", "/admin/dashboard", "/app", "/home"]) {
      try {
        await page.goto(candidate, { waitUntil: "domcontentloaded", timeout: 15_000 });
        await page.waitForTimeout(2000);
        if (!page.url().endsWith("/get-started") && !page.url().endsWith("/login")) {
          landing = page.url();
          break;
        }
      } catch {}
    }
  }
  console.log(`[recon] landed on: ${landing}`);
  await capture(page, "landing");

  // 4) Collect in-dashboard links via BFS (same-origin only), bounded
  const seen = new Set<string>();
  const queue: string[] = [landing];
  const maxPages = 40;
  const origin = new URL(landing).origin;

  while (queue.length && seen.size < maxPages) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    try {
      await page.goto(next, { waitUntil: "domcontentloaded", timeout: 20_000 });
    } catch (e) {
      console.warn(`skip ${next}: ${(e as Error).message}`);
      continue;
    }
    await page.waitForTimeout(1200);
    await capture(page, `dash_${seen.size.toString().padStart(2, "0")}`);

    // Extract same-origin anchor hrefs
    const hrefs: string[] = await page.$$eval("a[href]", (as) =>
      as.map((a) => (a as HTMLAnchorElement).href).filter(Boolean)
    );
    for (const href of hrefs) {
      try {
        const u = new URL(href);
        if (u.origin !== origin) continue;
        // Skip fragments and query-only
        const clean = u.origin + u.pathname;
        if (!seen.has(clean) && !queue.includes(clean)) {
          // Don't revisit public pages; focus on dashboard-ish routes
          const publicRoutes = ["/features", "/pricing", "/about", "/faqs", "/contact", "/onboard-chama", "/community", "/terms", "/get-started", "/register"];
          if (publicRoutes.some((r) => u.pathname === r)) continue;
          if (u.pathname === "/") continue;
          queue.push(clean);
        }
      } catch {}
    }
  }

  // 5) Save everything
  fs.writeFileSync(pageVisitsFile, JSON.stringify(visits, null, 2));
  fs.writeFileSync(
    path.join(RUN_DIR, "network", "requests.json"),
    JSON.stringify(networkLog, null, 2)
  );
  fs.writeFileSync(
    path.join(RUN_DIR, "console.json"),
    JSON.stringify(consoleMessages, null, 2)
  );
  fs.writeFileSync(
    path.join(RUN_DIR, "errors.json"),
    JSON.stringify(pageErrors, null, 2)
  );

  // 6) Summarize
  const apiCalls = networkLog.filter(
    (n) => n.resourceType !== "document" && !n.url.includes("/_next/")
  );
  const summary = {
    runDir: RUN_DIR,
    login: { email: EMAIL, landedOn: landing },
    pagesVisited: visits.length,
    apiRequestsCaptured: apiCalls.length,
    uniqueApiHosts: [...new Set(apiCalls.map((c) => new URL(c.url).host))],
    uniqueApiPaths: [...new Set(apiCalls.map((c) => new URL(c.url).pathname))],
    consoleErrors: consoleMessages.filter((c) => c.type === "error").length,
    pageErrors: pageErrors.length,
  };
  fs.writeFileSync(
    path.join(RUN_DIR, "summary.json"),
    JSON.stringify(summary, null, 2)
  );
  console.log("[recon] summary:", JSON.stringify(summary, null, 2));

  expect(visits.length).toBeGreaterThan(0);
});
