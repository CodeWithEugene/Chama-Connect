/**
 * Extended audit — targets attack surfaces the first pass did not cover.
 *
 * Every probe runs as a separate test so one failure doesn't cascade, and
 * each probe writes its raw artifact to `recon/artifacts/audit-<ts>/` so we
 * can cite evidence when filing bugs.
 *
 * Probes:
 *   1.  Static/asset exposure: robots, sitemap, .well-known, .map sourcemaps, .env, .git
 *   2.  HTTP method tampering: OPTIONS/TRACE/HEAD on sensitive endpoints
 *   3.  Content-Type bypass: signin with text/plain, form-urlencoded
 *   4.  CSRF: signin POST with no Origin/Referer
 *   5.  Cookie attribute audit: flags on session + any other cookies
 *   6.  Logout invalidation: does the old token still work?
 *   7.  Email case-sensitivity dupes on signup
 *   8.  Concurrent double-signup race
 *   9.  Negative / zero / overflow / NaN amount on contribution APIs
 *   10. Large-payload DoS (1 MB JSON body to signin)
 *   11. Open redirect: search for ?redirect / ?next / ?return_to
 *   12. Clickjacking: can /admin/dashboard be iframed?
 *   13. Prototype-pollution keys on signup (__proto__, constructor.prototype)
 *   14. Password strength: can you sign up with password "a"?
 *   15. Email-change without re-verification (via PATCH/PUT to /users/current-user)
 *   16. Timing on password-reset with known vs unknown email
 *   17. Cache-Control on /api/proxy responses (sensitive data cacheable?)
 *   18. `walletRepaired` flag — can it be forced true or exploited?
 *   19. OPTIONS preflight from evil origin: is it permissive?
 *   20. HEAD on /api/proxy/* endpoints: does it return body?
 */

import { test, expect, request, APIRequestContext, Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const EMAIL = process.env.email ?? "";
const PASSWORD = process.env.password ?? "";
const BASE = "https://chamaconnect.io";

const RUN_DIR = path.resolve(
  __dirname,
  "..",
  "artifacts",
  `audit-${new Date().toISOString().replace(/[:.]/g, "-")}`
);
fs.mkdirSync(RUN_DIR, { recursive: true });

function saveJson(name: string, data: unknown) {
  fs.writeFileSync(
    path.join(RUN_DIR, `${name}.json`),
    JSON.stringify(data, null, 2)
  );
}
function saveText(name: string, data: string) {
  fs.writeFileSync(path.join(RUN_DIR, `${name}.txt`), data);
}

async function freshRequest(): Promise<APIRequestContext> {
  return await request.newContext({ baseURL: BASE });
}

async function loginAndGetToken(api: APIRequestContext): Promise<string | null> {
  const resp = await api.post("/api/proxy/users/signin", {
    data: { email: EMAIL, password: PASSWORD },
    headers: { "content-type": "application/json" },
  });
  if (!resp.ok()) return null;
  const j = (await resp.json()) as any;
  return j?.data?.token ?? null;
}

async function authFetch(
  api: APIRequestContext,
  token: string,
  url: string,
  init: { method?: string; data?: any; headers?: Record<string, string> } = {}
) {
  return api.fetch(url, {
    method: init.method ?? "GET",
    data: init.data,
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

// ──────────────── PROBE 1 — static / asset exposure ────────────────
test("probe 01 · static exposure", async () => {
  const api = await freshRequest();
  const paths = [
    "/robots.txt",
    "/sitemap.xml",
    "/.well-known/security.txt",
    "/.well-known/change-password",
    "/.env",
    "/.env.local",
    "/.env.production",
    "/.git/config",
    "/.git/HEAD",
    "/package.json",
    "/package-lock.json",
    "/yarn.lock",
    "/next.config.js",
    "/next.config.ts",
    "/next-env.d.ts",
    "/_next/static/chunks/main.js.map",
    "/_next/static/chunks/webpack.js.map",
    "/_next/static/chunks/5c407928b5841955.js.map",
    "/_next/data/manifest.json",
    "/api/health",
    "/api/healthz",
    "/api/ready",
    "/api/status",
    "/api/metrics",
    "/api/version",
    "/api/debug",
    "/api/proxy/health",
    "/api/proxy/healthz",
    "/api/proxy/_health",
    "/api/proxy/admin",
    "/api/proxy/internal",
    "/api/proxy/dev",
    "/api/proxy/debug",
    "/api/proxy/swagger",
    "/api/proxy/docs",
    "/api/proxy/openapi.json",
    "/swagger",
    "/docs",
    "/api-docs",
    "/graphql",
    "/api/graphql",
  ];
  const results: Array<{ url: string; status: number; ct: string; size: number; sample: string }> = [];
  for (const p of paths) {
    try {
      const r = await api.get(p, { maxRedirects: 0 });
      const body = await r.body();
      const txt = body.toString("utf8").slice(0, 500);
      results.push({
        url: p,
        status: r.status(),
        ct: r.headers()["content-type"] ?? "",
        size: body.length,
        sample: txt,
      });
    } catch (e) {
      results.push({ url: p, status: 0, ct: "", size: 0, sample: (e as Error).message });
    }
  }
  saveJson("01_static_exposure", results);
  // soft assertion: nothing is blocked
  const hits = results.filter(
    (r) => r.status >= 200 && r.status < 400 && !/html/i.test(r.ct)
  );
  console.log(`[01] ${hits.length} non-html 2xx/3xx hits`);
});

// ──────────────── PROBE 2 — HTTP method tampering ────────────────
test("probe 02 · method tampering", async () => {
  const api = await freshRequest();
  const endpoints = [
    "/api/proxy/users/signin",
    "/api/proxy/users/current-user",
    "/api/proxy/groups",
    "/api/proxy/settings",
    "/api/proxy/transactions",
    "/api/proxy/notifications",
    "/api/auth/session",
    "/api/auth/token",
  ];
  const methods = ["OPTIONS", "TRACE", "HEAD", "PATCH", "PUT", "DELETE"];
  const rows: Array<{ url: string; method: string; status: number; allow?: string; cors?: string; body?: string }> = [];
  for (const url of endpoints) {
    for (const method of methods) {
      try {
        const r = await api.fetch(url, { method });
        const body = (await r.body()).toString("utf8").slice(0, 300);
        rows.push({
          url,
          method,
          status: r.status(),
          allow: r.headers().allow,
          cors: r.headers()["access-control-allow-origin"],
          body,
        });
      } catch (e) {
        rows.push({ url, method, status: 0, body: (e as Error).message });
      }
    }
  }
  saveJson("02_method_tampering", rows);
});

// ──────────────── PROBE 3 — content-type bypass on signin ────────────────
test("probe 03 · content-type bypass signin", async () => {
  const api = await freshRequest();
  const body = JSON.stringify({ email: "probe@example.com", password: "x" });
  const variants: Array<{ ct: string; data: any }> = [
    { ct: "text/plain", data: body },
    { ct: "application/json;charset=utf-8", data: body },
    { ct: "application/x-www-form-urlencoded", data: "email=probe@example.com&password=x" },
    { ct: "multipart/form-data; boundary=----X", data: `------X\r\nContent-Disposition: form-data; name="email"\r\n\r\nprobe@example.com\r\n------X--\r\n` },
    { ct: "", data: body },
  ];
  const rows: Array<{ ct: string; status: number; sample: string }> = [];
  for (const v of variants) {
    try {
      const r = await api.post("/api/proxy/users/signin", {
        data: v.data,
        headers: v.ct ? { "content-type": v.ct } : {},
      });
      rows.push({
        ct: v.ct || "(none)",
        status: r.status(),
        sample: (await r.text()).slice(0, 300),
      });
    } catch (e) {
      rows.push({ ct: v.ct, status: 0, sample: (e as Error).message });
    }
  }
  saveJson("03_content_type_bypass", rows);
});

// ──────────────── PROBE 4 — CSRF on auth endpoints ────────────────
test("probe 04 · csrf on auth endpoints", async () => {
  const api = await freshRequest();
  // Simulate cross-origin submission: set evil Origin and Referer
  const tests = [
    { url: "/api/proxy/users/signin", method: "POST", data: { email: "x@x.com", password: "x" } },
    { url: "/api/auth/session", method: "POST", data: { token: "eyJ0ZXN0IjoidGVzdCJ9" } },
    { url: "/api/auth/logout", method: "POST", data: {} },
  ];
  const rows: Array<{ url: string; evilOrigin: string; status: number; acao: string; body: string }> = [];
  for (const t of tests) {
    for (const origin of ["https://evil.example", "null", "http://localhost:1337"]) {
      try {
        const r = await api.fetch(t.url, {
          method: t.method,
          data: JSON.stringify(t.data),
          headers: {
            "content-type": "application/json",
            Origin: origin,
            Referer: `${origin}/evil.html`,
          },
        });
        rows.push({
          url: t.url,
          evilOrigin: origin,
          status: r.status(),
          acao: r.headers()["access-control-allow-origin"] ?? "",
          body: (await r.text()).slice(0, 200),
        });
      } catch (e) {
        rows.push({ url: t.url, evilOrigin: origin, status: 0, acao: "", body: (e as Error).message });
      }
    }
  }
  saveJson("04_csrf_auth", rows);
});

// ──────────────── PROBE 5 — cookie attribute audit ────────────────
test("probe 05 · cookie attribute audit", async ({ browser }) => {
  if (!EMAIL || !PASSWORD) test.skip(true, "no creds");
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/get-started`, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await Promise.all([
    page
      .waitForResponse((r) => r.url().includes("/api/auth/session") && r.request().method() === "POST", { timeout: 20_000 })
      .catch(() => null),
    page.getByRole("button", { name: /log\s*in|sign\s*in/i }).first().click(),
  ]);
  await page.waitForTimeout(3000);
  const cookies = await ctx.cookies();
  const rows = cookies.map((c) => ({
    name: c.name,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    session: c.expires === -1,
    expires: c.expires,
  }));
  saveJson("05_cookies", rows);
  await ctx.close();
});

// ──────────────── PROBE 6 — logout invalidation ────────────────
test("probe 06 · logout invalidation", async () => {
  if (!EMAIL || !PASSWORD) test.skip(true, "no creds");
  const api = await freshRequest();
  const token = await loginAndGetToken(api);
  if (!token) test.skip(true, "no token");
  const beforeLogout = await authFetch(api, token!, "/api/proxy/users/current-user");
  const beforeStatus = beforeLogout.status();
  // Try common logout paths
  const logoutAttempts: Array<{ url: string; method: string; status: number }> = [];
  for (const url of [
    "/api/proxy/users/logout",
    "/api/proxy/users/signout",
    "/api/proxy/auth/logout",
    "/api/auth/logout",
    "/api/auth/session",
  ]) {
    for (const method of ["POST", "DELETE"]) {
      try {
        const r = await authFetch(api, token!, url, { method });
        logoutAttempts.push({ url, method, status: r.status() });
      } catch {}
    }
  }
  const afterLogout = await authFetch(api, token!, "/api/proxy/users/current-user");
  saveJson("06_logout", {
    beforeStatus,
    afterStatus: afterLogout.status(),
    afterBody: (await afterLogout.text()).slice(0, 400),
    logoutAttempts,
  });
});

// ──────────────── PROBE 7 — email case-sensitivity dupes ────────────────
test("probe 07 · email case sensitivity on signin", async () => {
  if (!EMAIL || !PASSWORD) test.skip(true, "no creds");
  const api = await freshRequest();
  const variants = [
    EMAIL,
    EMAIL.toUpperCase(),
    EMAIL.replace("@", "@ ").replace(" ", ""), // whitespace test
    EMAIL + " ",
    " " + EMAIL,
    EMAIL.split("@")[0] + "+test@" + EMAIL.split("@")[1], // plus-addressing
  ];
  const rows: Array<{ email: string; status: number; message: string; timingMs: number }> = [];
  for (const email of variants) {
    const t0 = Date.now();
    const r = await api.post("/api/proxy/users/signin", {
      data: { email, password: PASSWORD },
      headers: { "content-type": "application/json" },
    });
    const dt = Date.now() - t0;
    const body = (await r.text()).slice(0, 200);
    rows.push({ email, status: r.status(), message: body, timingMs: dt });
  }
  saveJson("07_email_case", rows);
});

// ──────────────── PROBE 8 — concurrent double-signup race ────────────────
test("probe 08 · concurrent signup race", async () => {
  const api = await freshRequest();
  const email = `race-${Date.now()}@probe.local`;
  const body = {
    firstName: "Race",
    lastName: "Test",
    email,
    phone: `+25470${Math.floor(Math.random() * 10_000_000).toString().padStart(7, "0")}`,
    password: "Password123!",
    country: "KE",
  };
  // 2 concurrent only — we're probing for race-condition unique-index behaviour,
  // not DoS'ing production. Sequential follow-up would miss the race.
  const tasks = Array.from({ length: 2 }, () =>
    api.post("/api/proxy/users/signup", {
      data: body,
      headers: { "content-type": "application/json" },
    })
  );
  const results = await Promise.allSettled(tasks);
  const rows = results.map((r, i) => ({
    i,
    status: r.status === "fulfilled" ? (r.value as any).status() : 0,
    err: r.status === "rejected" ? (r.reason as Error).message : null,
  }));
  saveJson("08_race_signup", { email, rows });
});

// ──────────────── PROBE 9 — numeric edge cases on contribute ────────────────
test("probe 09 · numeric edge cases", async () => {
  if (!EMAIL || !PASSWORD) test.skip(true, "no creds");
  const api = await freshRequest();
  const token = await loginAndGetToken(api);
  if (!token) test.skip(true, "no token");
  const endpoints = [
    "/api/proxy/transactions",
    "/api/proxy/groups",
  ];
  const values: any[] = [-1, -0.01, 0, 1e308, Number.MAX_SAFE_INTEGER + 1, "NaN", "Infinity", null, {}, []];
  const rows: Array<{ url: string; value: any; status: number; body: string }> = [];
  for (const url of endpoints) {
    for (const amount of values) {
      try {
        const r = await authFetch(api, token!, url, {
          method: "POST",
          data: { amount, description: "audit probe", currency: "KES" },
        });
        rows.push({
          url,
          value: typeof amount === "object" ? JSON.stringify(amount) : amount,
          status: r.status(),
          body: (await r.text()).slice(0, 200),
        });
      } catch (e) {
        rows.push({ url, value: amount, status: 0, body: (e as Error).message });
      }
    }
  }
  saveJson("09_numeric_edge", rows);
});

// ──────────────── PROBE 10 — large-payload DoS ────────────────
test("probe 10 · large payload", async () => {
  const api = await freshRequest();
  // Capped at 100 KB — enough to detect "no body-size limit" while staying well
  // under any reasonable DoS threshold. If the server accepts 100 KB without
  // a size cap, then a malicious actor with a real Mb/s could trivially scale.
  const sizes = [1_000, 10_000, 100_000];
  const rows: Array<{ size: number; status: number; ms: number; body: string }> = [];
  for (const s of sizes) {
    const t0 = Date.now();
    try {
      const r = await api.post("/api/proxy/users/signin", {
        data: { email: "a@b.c", password: "x".repeat(s) },
        headers: { "content-type": "application/json" },
        timeout: 30_000,
      });
      rows.push({
        size: s,
        status: r.status(),
        ms: Date.now() - t0,
        body: (await r.text()).slice(0, 200),
      });
    } catch (e) {
      rows.push({ size: s, status: 0, ms: Date.now() - t0, body: (e as Error).message });
    }
  }
  saveJson("10_large_payload", rows);
});

// ──────────────── PROBE 11 — open redirect scan ────────────────
test("probe 11 · open redirect scan", async () => {
  const api = await freshRequest();
  const params = ["redirect", "redirect_to", "return", "return_to", "returnUrl", "next", "url", "u", "target", "callback", "callbackUrl", "dest", "destination"];
  const bases = ["/", "/get-started", "/register", "/forgot-password", "/api/auth/session", "/auth/verify", "/admin/dashboard"];
  const evil = "https://evil.example/xxx";
  const rows: Array<{ url: string; status: number; loc: string; body: string }> = [];
  for (const b of bases) {
    for (const p of params) {
      const u = `${b}?${p}=${encodeURIComponent(evil)}`;
      try {
        const r = await api.get(u, { maxRedirects: 0 });
        const loc = r.headers().location ?? "";
        const body = (await r.text()).slice(0, 120);
        if (loc.includes("evil.example") || body.includes("evil.example")) {
          rows.push({ url: u, status: r.status(), loc, body });
        }
      } catch {}
    }
  }
  saveJson("11_open_redirect", rows);
});

// ──────────────── PROBE 12 — clickjacking ────────────────
test("probe 12 · clickjacking", async () => {
  const api = await freshRequest();
  const paths = ["/", "/admin/dashboard", "/admin/chamas", "/admin/settings", "/get-started", "/auth/verify"];
  const rows: Array<{ url: string; xfo: string; csp: string; referrer: string }> = [];
  for (const p of paths) {
    const r = await api.get(p, { maxRedirects: 0 });
    const h = r.headers();
    rows.push({
      url: p,
      xfo: h["x-frame-options"] ?? "",
      csp: (h["content-security-policy"] ?? "").slice(0, 200),
      referrer: h["referrer-policy"] ?? "",
    });
  }
  saveJson("12_clickjacking", rows);
});

// ──────────────── PROBE 13 — prototype-pollution on signup ────────────────
test("probe 13 · prototype pollution", async () => {
  const api = await freshRequest();
  const payloads: any[] = [
    { __proto__: { isSuperadmin: true, role: { name: "SuperAdmin" } } },
    { constructor: { prototype: { isSuperadmin: true } } },
    { "__proto__.isSuperadmin": true },
    { "constructor.prototype.polluted": true },
  ];
  const rows: Array<{ sent: string; status: number; sample: string }> = [];
  const baseUser = {
    firstName: "Proto",
    lastName: "Poll",
    email: `pp-${Date.now()}@probe.local`,
    phone: `+25470${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
    password: "Password123!",
    country: "KE",
  };
  for (const extra of payloads) {
    try {
      const r = await api.post("/api/proxy/users/signup", {
        data: { ...baseUser, ...extra },
        headers: { "content-type": "application/json" },
      });
      rows.push({
        sent: Object.keys(extra).join(","),
        status: r.status(),
        sample: (await r.text()).slice(0, 400),
      });
    } catch (e) {
      rows.push({ sent: Object.keys(extra).join(","), status: 0, sample: (e as Error).message });
    }
  }
  saveJson("13_proto_pollution", rows);
});

// ──────────────── PROBE 14 — password-strength audit ────────────────
test("probe 14 · password strength", async () => {
  const api = await freshRequest();
  const passwords = ["a", "1", "aa", "12345", "password", "password123", "        ", "🔐", "aA1!"];
  const rows: Array<{ pw: string; status: number; msg: string }> = [];
  for (const pw of passwords) {
    const email = `pw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@probe.local`;
    try {
      const r = await api.post("/api/proxy/users/signup", {
        data: {
          firstName: "PW",
          lastName: "Test",
          email,
          phone: `+25470${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
          password: pw,
          country: "KE",
        },
        headers: { "content-type": "application/json" },
      });
      rows.push({ pw, status: r.status(), msg: (await r.text()).slice(0, 200) });
    } catch (e) {
      rows.push({ pw, status: 0, msg: (e as Error).message });
    }
  }
  saveJson("14_password_strength", rows);
});

// ──────────────── PROBE 15 — email change without re-verification ────────────────
test("probe 15 · email change without re-verify", async () => {
  if (!EMAIL || !PASSWORD) test.skip(true, "no creds");
  const api = await freshRequest();
  const token = await loginAndGetToken(api);
  if (!token) test.skip(true, "no token");
  const rows: Array<{ url: string; method: string; status: number; body: string }> = [];
  const candidates = [
    "/api/proxy/users/update-profile",
    "/api/proxy/users/current-user",
    "/api/proxy/users/update-email",
    "/api/proxy/users/change-email",
    "/api/proxy/users/profile",
    "/api/proxy/users/me",
  ];
  const body = { email: `pwned-${Date.now()}@probe.local`, firstName: "Hack", lastName: "Hack" };
  for (const url of candidates) {
    for (const method of ["PATCH", "PUT", "POST"]) {
      try {
        const r = await authFetch(api, token!, url, { method, data: body });
        rows.push({ url, method, status: r.status(), body: (await r.text()).slice(0, 300) });
      } catch (e) {
        rows.push({ url, method, status: 0, body: (e as Error).message });
      }
    }
  }
  saveJson("15_email_change", rows);
});

// ──────────────── PROBE 16 — timing on password-reset ────────────────
test("probe 16 · password reset timing", async () => {
  const api = await freshRequest();
  const known = EMAIL || "eugenegabriel.ke@gmail.com";
  const unknown = `nonexistent-${Date.now()}@probe.local`;
  const timings: Array<{ kind: string; ms: number; status: number; bodyLen: number }> = [];
  for (const kind of ["known", "unknown", "known", "unknown", "known", "unknown"]) {
    const emailToTry = kind === "known" ? known : unknown;
    const t0 = Date.now();
    const r = await api.post("/api/proxy/users/request-password-reset", {
      data: { email: emailToTry },
      headers: { "content-type": "application/json" },
    });
    const body = await r.text();
    timings.push({
      kind,
      ms: Date.now() - t0,
      status: r.status(),
      bodyLen: body.length,
    });
  }
  saveJson("16_pw_reset_timing", timings);
});

// ──────────────── PROBE 17 — cache-control on api responses ────────────────
test("probe 17 · cache-control on api", async () => {
  if (!EMAIL || !PASSWORD) test.skip(true, "no creds");
  const api = await freshRequest();
  const token = await loginAndGetToken(api);
  if (!token) test.skip(true, "no token");
  const urls = [
    "/api/proxy/users/current-user",
    "/api/proxy/settings",
    "/api/proxy/groups",
    "/api/proxy/notifications",
    "/api/proxy/roles",
  ];
  const rows: Array<{ url: string; cacheControl: string; pragma: string; vary: string; etag: string }> = [];
  for (const url of urls) {
    const r = await authFetch(api, token!, url);
    const h = r.headers();
    rows.push({
      url,
      cacheControl: h["cache-control"] ?? "",
      pragma: h["pragma"] ?? "",
      vary: h["vary"] ?? "",
      etag: h["etag"] ?? "",
    });
  }
  saveJson("17_cache_control", rows);
});

// ──────────────── PROBE 18 — walletRepaired flag ────────────────
test("probe 18 · walletRepaired flag", async () => {
  if (!EMAIL || !PASSWORD) test.skip(true, "no creds");
  const api = await freshRequest();
  // Login twice and compare walletRepaired
  const rows: Array<{ i: number; walletRepaired: boolean | null; walletCreatedAt: string | null; blockchainAddress: string }> = [];
  for (let i = 0; i < 3; i++) {
    const r = await api.post("/api/proxy/users/signin", {
      data: { email: EMAIL, password: PASSWORD },
      headers: { "content-type": "application/json" },
    });
    const j = (await r.json()) as any;
    rows.push({
      i,
      walletRepaired: j?.data?.walletRepaired ?? null,
      walletCreatedAt: j?.data?.user?.walletCreatedAt ?? null,
      blockchainAddress: (j?.data?.user?.blockchainAddress ?? "").slice(0, 10) + "…",
    });
  }
  saveJson("18_wallet_repaired", rows);
});

// ──────────────── PROBE 19 — CORS preflight from evil origin ────────────────
test("probe 19 · cors preflight", async () => {
  const api = await freshRequest();
  const urls = [
    "/api/proxy/users/signin",
    "/api/proxy/users/current-user",
    "/api/proxy/groups",
    "/api/proxy/settings",
    "/api/auth/session",
  ];
  const origins = [
    "https://chamaconnect.io",
    "https://evil.example",
    "http://localhost:3000",
    "null",
    "https://attacker.chamaconnect.io.evil.example",
  ];
  const rows: Array<{ url: string; origin: string; status: number; acao: string; acac: string; acam: string; allowHeaders: string }> = [];
  for (const url of urls) {
    for (const origin of origins) {
      const r = await api.fetch(url, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,authorization",
        },
      });
      const h = r.headers();
      rows.push({
        url,
        origin,
        status: r.status(),
        acao: h["access-control-allow-origin"] ?? "",
        acac: h["access-control-allow-credentials"] ?? "",
        acam: h["access-control-allow-methods"] ?? "",
        allowHeaders: h["access-control-allow-headers"] ?? "",
      });
    }
  }
  saveJson("19_cors_preflight", rows);
});

// ──────────────── PROBE 20 — HEAD vs GET parity ────────────────
test("probe 20 · HEAD vs GET parity", async () => {
  if (!EMAIL || !PASSWORD) test.skip(true, "no creds");
  const api = await freshRequest();
  const token = await loginAndGetToken(api);
  if (!token) test.skip(true, "no token");
  const urls = ["/api/proxy/users/current-user", "/api/proxy/groups", "/api/proxy/settings"];
  const rows: Array<{ url: string; headStatus: number; headSize: number; getStatus: number; getSize: number }> = [];
  for (const url of urls) {
    const head = await authFetch(api, token!, url, { method: "HEAD" });
    const get = await authFetch(api, token!, url, { method: "GET" });
    rows.push({
      url,
      headStatus: head.status(),
      headSize: (await head.body()).length,
      getStatus: get.status(),
      getSize: (await get.body()).length,
    });
  }
  saveJson("20_head_parity", rows);
});
