/**
 * deep-interact.spec.ts
 *
 * Goes beyond passive crawling — actually CLICKS every button, opens every
 * modal/wizard, submits every form (with safe probe data), exercises search,
 * filters, pagination, profile edit, password change, logout, etc.
 *
 * All API calls are captured to network/deep-interact-requests.json for
 * offline grepping of new endpoint surface.
 */
import { test, expect, Page, Request, Response } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

const EMAIL    = process.env.email    ?? process.env.EMAIL    ?? "";
const PASSWORD = process.env.password ?? process.env.PASSWORD ?? "";
if (!EMAIL || !PASSWORD) throw new Error("Need email + password in .env");

const RUN_DIR = path.resolve(
  __dirname, "..", "artifacts",
  `deep-${new Date().toISOString().replace(/[:.]/g, "-")}`
);
["screenshots","html","network"].forEach((d) =>
  fs.mkdirSync(path.join(RUN_DIR, d), { recursive: true })
);

type NetEntry = {
  method: string; url: string; status: number | null;
  requestBody: string | null; responseBody: string | null;
  fromPage: string; ts: string;
};
const NET: NetEntry[] = [];
const ERRORS: string[] = [];

async function instrument(page: Page) {
  page.on("pageerror", (e) => ERRORS.push(`${page.url()} :: ${e.message}`));
  page.on("requestfinished", async (req: Request) => {
    const rt = req.resourceType();
    if (!["xhr","fetch","document"].includes(rt)) return;
    const resp: Response | null = await req.response().catch(() => null);
    let reqBody: string | null = null;
    try { reqBody = req.postData() ?? null; } catch {}
    let respBody: string | null = null;
    if (resp) {
      try {
        const ct = (await resp.headers())["content-type"] ?? "";
        if (ct.includes("json") || ct.includes("text")) {
          const b = await resp.body().catch(() => null);
          if (b && b.length < 100_000) respBody = b.toString("utf8");
        }
      } catch {}
    }
    NET.push({
      method: req.method(), url: req.url(),
      status: resp?.status() ?? null,
      requestBody: reqBody, responseBody: respBody,
      fromPage: page.url(), ts: new Date().toISOString()
    });
  });
}

async function shot(page: Page, label: string) {
  const safe = label.replace(/[^a-z0-9_-]/gi, "_").slice(0, 60);
  await page.screenshot({ path: path.join(RUN_DIR,"screenshots",`${safe}.png`), fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => "");
  fs.writeFileSync(path.join(RUN_DIR,"html",`${safe}.html`), html);
}

async function login(page: Page) {
  await page.goto("/get-started", { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForTimeout(1500);
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  const done = page.waitForURL((u) => !u.toString().includes("/get-started"), { timeout: 20_000 }).catch(() => {});
  await page.locator('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in"), button:has-text("Continue")').first().click();
  await done;
  await page.waitForTimeout(2000);
}

test("deep interaction audit", async ({ page }) => {
  test.setTimeout(20 * 60 * 1000);
  await instrument(page);
  await login(page);
  await shot(page, "01_dashboard_landing");

  // ── DASHBOARD OVERVIEW ─────────────────────────────────────────────────────
  // Click every stat card / quick-action button visible on landing
  const dashButtons = await page.locator("button, a[href]").all();
  console.log(`[interact] dashboard has ${dashButtons.length} clickable elements`);

  // ── CHAMAS LIST ────────────────────────────────────────────────────────────
  for (const chamaPath of ["/admin/chamas", "/admin/dashboard"]) {
    await page.goto(chamaPath, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await shot(page, `02_chamas_${chamaPath.replace(/\//g, "_")}`);

    // Try "Create Chama / New Group" button
    const createBtn = page.locator('button:has-text("Create"), button:has-text("New"), button:has-text("Add"), a:has-text("Create"), a:has-text("New")').first();
    if (await createBtn.isVisible().catch(() => false)) {
      await createBtn.click();
      await page.waitForTimeout(1500);
      await shot(page, "03_create_chama_modal");
      // Fill out the form fields if visible
      const nameInput = page.locator('input[placeholder*="name" i], input[name="name"]').first();
      if (await nameInput.isVisible().catch(() => false)) {
        await nameInput.fill("Security Test Chama PROBE");
        await shot(page, "03b_create_chama_filled");
      }
      // Close / cancel
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
    }

    // Click into a chama row if any exist
    const chamaRow = page.locator('tr, [data-testid*="chama"], .chama-item, .group-item').first();
    if (await chamaRow.isVisible().catch(() => false)) {
      await chamaRow.click();
      await page.waitForTimeout(1500);
      await shot(page, "04_chama_detail");
      await page.goBack().catch(() => {});
      await page.waitForTimeout(1000);
    }
  }

  // ── TRANSACTIONS ───────────────────────────────────────────────────────────
  await page.goto("/admin/transactions", { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await shot(page, "05_transactions");

  // Try to click approve / reject on any transaction
  for (const action of ["Approve","Reject","View","Details"]) {
    const btn = page.locator(`button:has-text("${action}"), a:has-text("${action}")`).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(1500);
      await shot(page, `05b_tx_${action.toLowerCase()}`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
    }
  }

  // Search + filter
  const searchInput = page.locator('input[type="search"], input[placeholder*="search" i], input[placeholder*="filter" i]').first();
  if (await searchInput.isVisible().catch(() => false)) {
    await searchInput.fill("test");
    await page.waitForTimeout(1000);
    await shot(page, "05c_tx_search");
    await searchInput.clear();
  }

  // ── NOTIFICATIONS ──────────────────────────────────────────────────────────
  await page.goto("/admin/notifications", { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await shot(page, "06_notifications");
  // Mark all read
  const markRead = page.locator('button:has-text("Mark all"), button:has-text("Clear")').first();
  if (await markRead.isVisible().catch(() => false)) {
    await markRead.click();
    await page.waitForTimeout(1000);
    await shot(page, "06b_notifications_marked");
  }

  // ── PROFILE ────────────────────────────────────────────────────────────────
  await page.goto("/admin/profile", { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await shot(page, "07_profile");

  // Edit profile
  const editBtn = page.locator('button:has-text("Edit"), button:has-text("Update"), button:has-text("Save")').first();
  if (await editBtn.isVisible().catch(() => false)) {
    await editBtn.click();
    await page.waitForTimeout(1000);
    await shot(page, "07b_profile_edit");

    // Try injecting XSS in first name
    const firstNameInput = page.locator('input[name="firstName"], input[placeholder*="first" i]').first();
    if (await firstNameInput.isVisible().catch(() => false)) {
      await firstNameInput.fill('<script>alert(1)</script>');
      await shot(page, "07c_profile_xss_fill");
      // Clear and re-fill with real name
      await firstNameInput.fill("Eugene");
    }

    // Profile picture upload
    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.isVisible().catch(() => false)) {
      await shot(page, "07d_profile_file_input");
    }

    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  }

  // Change password button
  const changePwBtn = page.locator('button:has-text("Change Password"), button:has-text("Password"), a:has-text("Change Password")').first();
  if (await changePwBtn.isVisible().catch(() => false)) {
    await changePwBtn.click();
    await page.waitForTimeout(1000);
    await shot(page, "07e_change_password");

    // Try change password WITHOUT old password — check if oldPassword is required
    const newPwInput = page.locator('input[type="password"]').nth(0);
    const confirmPwInput = page.locator('input[type="password"]').nth(1);
    if (await newPwInput.isVisible().catch(() => false)) {
      await newPwInput.fill("NewPassword123!@#");
      if (await confirmPwInput.isVisible().catch(() => false)) {
        await confirmPwInput.fill("NewPassword123!@#");
      }
      await shot(page, "07f_change_pw_filled");
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  }

  // ── ADMIN SETTINGS ─────────────────────────────────────────────────────────
  await page.goto("/admin/settings", { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await shot(page, "08_settings");
  // What does the settings page show? Any save buttons?
  const saveBtns = await page.locator('button:has-text("Save"), button:has-text("Update"), button[type="submit"]').all();
  console.log(`[interact] settings page has ${saveBtns.length} save buttons`);
  await shot(page, "08b_settings_full");

  // ── CREATE GROUP FULL FLOW ─────────────────────────────────────────────────
  await page.goto("/admin/create-group", { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await shot(page, "09_create_group");

  // Fill in all fields
  const inputs = await page.locator("input, select, textarea").all();
  console.log(`[interact] create-group has ${inputs.length} inputs`);
  for (let i = 0; i < Math.min(inputs.length, 20); i++) {
    const inp = inputs[i];
    const type = await inp.getAttribute("type").catch(() => "text");
    const name = await inp.getAttribute("name").catch(() => "");
    const placeholder = await inp.getAttribute("placeholder").catch(() => "");
    if (type === "file") continue;
    if (type === "checkbox" || type === "radio") { await inp.check().catch(() => {}); continue; }
    if (type === "email") { await inp.fill("test@example.com").catch(() => {}); continue; }
    if (type === "number") { await inp.fill("100").catch(() => {}); continue; }
    if (type === "tel" || name?.includes("phone") || placeholder?.toLowerCase().includes("phone")) {
      await inp.fill("+254711111111").catch(() => {}); continue;
    }
    await inp.fill("Probe Value").catch(() => {});
  }
  await shot(page, "09b_create_group_filled");

  // ── LOGOUT + TOKEN REUSE TEST ───────────────────────────────────────────────
  // Capture token before logout
  const cookies = await page.context().cookies();
  const authCookie = cookies.find((c) => c.name === "auth_token");
  const tokenBeforeLogout = authCookie?.value ?? "";
  console.log(`[interact] auth_token before logout length=${tokenBeforeLogout.length}`);
  fs.writeFileSync(path.join(RUN_DIR, "token_before_logout.txt"), tokenBeforeLogout);

  // Find logout button
  const logoutBtn = page.locator('button:has-text("Logout"), button:has-text("Log out"), a:has-text("Logout"), a:has-text("Sign out")').first();
  if (await logoutBtn.isVisible().catch(() => false)) {
    await logoutBtn.click();
    await page.waitForTimeout(2000);
    await shot(page, "10_after_logout");
    console.log(`[interact] post-logout url: ${page.url()}`);

    // Check if cookie was cleared
    const cookiesAfter = await page.context().cookies();
    const authCookieAfter = cookiesAfter.find((c) => c.name === "auth_token");
    console.log(`[interact] auth_token after logout: ${authCookieAfter ? `present (len=${authCookieAfter.value.length})` : "CLEARED"}`);
    fs.writeFileSync(path.join(RUN_DIR, "token_after_logout.txt"), authCookieAfter?.value ?? "CLEARED");

    // Token reuse: manually re-inject the old token and try to hit a protected page
    if (tokenBeforeLogout) {
      await page.context().addCookies([{
        name: "auth_token", value: tokenBeforeLogout,
        domain: "chamaconnect.io", path: "/", secure: true, httpOnly: true, sameSite: "Strict"
      }]);
      await page.goto("/admin/dashboard", { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(2000);
      await shot(page, "11_token_reuse_after_logout");
      console.log(`[interact] token-reuse page: ${page.url()}`);
      fs.writeFileSync(path.join(RUN_DIR, "token_reuse_url.txt"), page.url());
    }
  } else {
    console.log("[interact] no logout button found on create-group page; trying profile page");
    await page.goto("/admin/profile", { waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const lb2 = page.locator('button:has-text("Logout"), button:has-text("Log out"), a:has-text("Logout"), a:has-text("Sign out")').first();
    if (await lb2.isVisible().catch(() => false)) {
      await lb2.click();
      await page.waitForTimeout(2000);
      await shot(page, "10_after_logout_profile");
    }
  }

  // ── 2FA PAGE PROBE ─────────────────────────────────────────────────────────
  // Navigate to /auth/2fa and check if it's accessible without completing login flow
  await page.goto("/auth/2fa", { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await shot(page, "12_2fa_page");
  console.log(`[interact] /auth/2fa url after nav: ${page.url()}`);

  // Try submitting 2FA with random OTPs
  const otpInput = page.locator('input[aria-label*="2FA" i], input[placeholder*="code" i], input[maxlength="6"]').first();
  if (await otpInput.isVisible().catch(() => false)) {
    for (const otp of ["000000","123456","999999","000001"]) {
      await otpInput.fill(otp);
      const verifyBtn = page.locator('button:has-text("Verify"), button:has-text("Continue"), button[type="submit"]').first();
      if (await verifyBtn.isVisible().catch(() => false)) {
        const resp = page.waitForResponse((r) => r.url().includes("2fa") || r.url().includes("otp") || r.url().includes("verify"), { timeout: 5000 }).catch(() => null);
        await verifyBtn.click();
        const r = await resp;
        if (r) {
          console.log(`[interact] 2fa otp=${otp} → ${r.status()} ${r.url()}`);
          let body = ""; try { body = await r.text(); } catch {}
          fs.appendFileSync(path.join(RUN_DIR, "2fa_probe.txt"), `otp=${otp} status=${r.status()} body=${body.slice(0,200)}\n`);
        }
      }
      await page.waitForTimeout(500);
    }
    await shot(page, "12b_2fa_after_probes");
  }

  // ── SAVE NETWORK LOG ───────────────────────────────────────────────────────
  fs.writeFileSync(
    path.join(RUN_DIR, "network", "deep-interact-requests.json"),
    JSON.stringify(NET, null, 2)
  );
  fs.writeFileSync(
    path.join(RUN_DIR, "page_errors.json"),
    JSON.stringify(ERRORS, null, 2)
  );

  // Summarise unique API paths hit during this run
  const apiPaths = [...new Set(
    NET.filter((n) => n.url.includes("/api/"))
       .map((n) => { try { return new URL(n.url).pathname; } catch { return n.url; } })
  )].sort();
  console.log("[interact] unique API paths hit:\n" + apiPaths.join("\n"));
  fs.writeFileSync(path.join(RUN_DIR, "api_paths.txt"), apiPaths.join("\n"));

  expect(NET.length).toBeGreaterThan(5);
});
