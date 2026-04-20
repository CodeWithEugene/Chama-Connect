/**
 * Audit pass 3 — the interactive gaps the user authorised ("ALL", "GO AHEAD").
 *
 * Uses Eugene's own account (already email-verified), with EXPLICIT REVERTS
 * for every mutation. Each probe captures before/after via /current-user and
 * restores the original value if the mutation stuck. Also includes a Create-
 * Chama wizard walk-through that cleans up the test chama at the end.
 *
 * Probes:
 *  30  Mass-assignment on /users/update-profile — send every dangerous field
 *      in ONE request, capture which stuck, restore.
 *  31  Profile-picture upload: SVG-with-<script>, HTML-as-PNG, oversized,
 *      traversal filename, MIME mismatch — all on Eugene, revert at end.
 *  32  Form-urlencoded mutations across the known endpoint surface.
 *  33  Create-Chama wizard: walk steps 1→5 with Playwright, capture each API
 *      request, then attempt to DELETE the created chama.
 *  34  Supply-chain fingerprints: detect library versions embedded in captured
 *      bundles (runtime-safe, no network).
 */

import { test, expect, request, APIRequestContext, Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const BASE = "https://chamaconnect.io";
const EMAIL = process.env.email!;
const PASSWORD = process.env.password!;

const RUN_DIR = path.resolve(
  __dirname,
  "..",
  "artifacts",
  `audit3-${new Date().toISOString().replace(/[:.]/g, "-")}`
);
fs.mkdirSync(RUN_DIR, { recursive: true });
const save = (name: string, data: unknown) =>
  fs.writeFileSync(path.join(RUN_DIR, `${name}.json`), JSON.stringify(data, null, 2));

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

async function loginEugene(api: APIRequestContext): Promise<{ token: string; user: any }> {
  const r = await api.post("/api/proxy/users/signin", {
    data: { email: EMAIL, password: PASSWORD },
    headers: { "content-type": "application/json" },
  });
  const j = (await r.json()) as any;
  return { token: j.data.token, user: j.data.user };
}

// ───────────────────── 30 · mass-assignment evidence ─────────────────────
test("probe 30 · mass-assignment on update-profile (Eugene, revertable)", async () => {
  const api = await request.newContext({ baseURL: BASE });
  const { token, user: before } = await loginEugene(api);

  // Dangerous fields to probe. DO NOT include anything that cannot be reverted
  // by re-PATCHing with the original value.
  const dangerous = {
    role:           { id: "69c50c8a38f08070a83bd361", name: "SuperAdmin" },
    roleId:         "69c50c8a38f08070a83bd361",
    isSuperadmin:   true,
    userType:       "SUPERADMIN",
    emailVerified:  false,                // flipping from true→false is the scary direction
    isActive:       false,
    accountStatus:  "BLOCKED",
    blockchainAddress: "0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF",
    permissions:    ["*"],
    deletionRequestedAt: "2020-01-01T00:00:00Z",
    activatedAt:    "1970-01-01T00:00:00Z",
    createdAt:      "1970-01-01T00:00:00Z",
    id:             "deadbeefdeadbeefdeadbeef",
    _id:            "deadbeefdeadbeefdeadbeef",
  };

  // Endpoint validator requires these three base fields — if they are missing,
  // the request 400s at validation and mass-assignment is never tested. Send
  // the *original* values for these three so the validator passes, then let
  // every `dangerous` field ride along behind them.
  const payload = {
    firstName: (before as any).firstName,
    lastName:  (before as any).lastName,
    email:     (before as any).email,
    ...dangerous,
  };
  const patch = await api.fetch("/api/proxy/users/update-profile", {
    method: "PATCH",
    data: JSON.stringify(payload),
    headers: authHeaders(token),
  });
  const patchBody = await patch.text();

  const afterResp = await api.get("/api/proxy/users/current-user", { headers: authHeaders(token) });
  const after = (await afterResp.json())?.data ?? {};

  // Figure out what stuck.
  const stuck: Record<string, { before: unknown; after: unknown }> = {};
  for (const k of Object.keys(dangerous)) {
    const b = (before as any)[k];
    const a = (after as any)[k];
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      stuck[k] = { before: b, after: a };
    }
  }

  save("30_mass_assignment", {
    sent: dangerous,
    patchStatus: patch.status(),
    patchBody: patchBody.slice(0, 600),
    stuck,
    summary: {
      isSuperadminStuck: (after as any).isSuperadmin !== (before as any).isSuperadmin,
      roleStuck:         JSON.stringify((after as any).role) !== JSON.stringify((before as any).role),
      roleIdStuck:       (after as any).roleId !== (before as any).roleId,
      accountStatusStuck:(after as any).accountStatus !== (before as any).accountStatus,
      emailVerifiedStuck:(after as any).emailVerified !== (before as any).emailVerified,
      blockchainStuck:   (after as any).blockchainAddress !== (before as any).blockchainAddress,
    },
  });

  // Revert anything that stuck. Only send the minimum set.
  if (Object.keys(stuck).length > 0) {
    const revertBody: Record<string, unknown> = {};
    for (const k of Object.keys(stuck)) revertBody[k] = (before as any)[k];
    const revert = await api.fetch("/api/proxy/users/update-profile", {
      method: "PATCH",
      data: JSON.stringify(revertBody),
      headers: authHeaders(token),
    });
    const afterRevertResp = await api.get("/api/proxy/users/current-user", { headers: authHeaders(token) });
    const afterRevert = (await afterRevertResp.json())?.data ?? {};
    const stillStuck: Record<string, { before: unknown; nowIs: unknown }> = {};
    for (const k of Object.keys(stuck)) {
      if (JSON.stringify((before as any)[k]) !== JSON.stringify((afterRevert as any)[k])) {
        stillStuck[k] = { before: (before as any)[k], nowIs: (afterRevert as any)[k] };
      }
    }
    save("30_mass_assignment_revert", {
      revertStatus: revert.status(),
      revertBody: (await revert.text()).slice(0, 400),
      stillStuck,
    });
  }
});

// ───────────────────── 31 · file upload probes ─────────────────────
test("probe 31 · profile-picture upload variants (Eugene, revertable)", async () => {
  const api = await request.newContext({ baseURL: BASE });
  const { token, user: before } = await loginEugene(api);
  const originalPicture: string = (before as any).profilePicture ?? "";

  const shots: Array<{ name: string; field: string; status: number; body: string; ct: string }> = [];
  async function send(label: string, field: string, buffer: Buffer, mime: string, filename: string) {
    const r = await api.post("/api/proxy/users/update-profile-picture", {
      multipart: { [field]: { name: filename, mimeType: mime, buffer } },
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await r.text();
    shots.push({
      name: label,
      field,
      status: r.status(),
      body: body.slice(0, 500),
      ct: r.headers()["content-type"] ?? "",
    });
  }

  const svgXss = Buffer.from(
    `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">
  <script>alert("XSS via SVG")</script>
  <rect width="10" height="10" fill="red"/>
</svg>`
  );
  for (const field of ["profilePicture", "file", "image", "avatar"]) {
    await send("svg-xss", field, svgXss, "image/svg+xml", "evil.svg");
  }

  const html = Buffer.from(`<html><body><script>alert('html-as-png')</script></body></html>`);
  await send("html-as-png", "profilePicture", html, "image/png", "evil.html");

  const tinyPng = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
  await send("path-traversal-filename", "profilePicture", tinyPng, "image/png", "../../../../../../etc/passwd");

  await send("text-mime-image", "profilePicture", Buffer.from("just text"), "image/jpeg", "plain.txt");

  // Oversized — capped at 2 MB to be a reasonable test (not a DoS).
  const big = Buffer.alloc(2 * 1024 * 1024, 0);
  big[0] = 0x89; big[1] = 0x50; big[2] = 0x4e; big[3] = 0x47;
  await send("oversized-png-2mb", "profilePicture", big, "image/png", "huge.png");

  // Capture the resulting profilePicture URL (if any stuck).
  const afterResp = await api.get("/api/proxy/users/current-user", { headers: authHeaders(token) });
  const after = (await afterResp.json())?.data ?? {};
  const finalPicture = (after as any).profilePicture ?? "";

  save("31_file_upload", {
    shots,
    beforePicture: originalPicture,
    finalPicture,
    pictureChanged: finalPicture !== originalPicture,
  });

  // If the profile picture got mutated, revert it.
  if (finalPicture !== originalPicture) {
    const revert = await api.fetch("/api/proxy/users/update-profile", {
      method: "PATCH",
      data: JSON.stringify({ profilePicture: originalPicture }),
      headers: authHeaders(token),
    });
    save("31_file_upload_revert", {
      revertStatus: revert.status(),
      revertBody: (await revert.text()).slice(0, 300),
    });
  }
});

// ───────────────────── 32 · form-urlencoded on mutations ─────────────────────
test("probe 32 · form-urlencoded mutation CSRF surface (Eugene)", async () => {
  const api = await request.newContext({ baseURL: BASE });
  const { token, user: before } = await loginEugene(api);

  const rows: Array<{ url: string; method: string; ct: string; status: number; body: string }> = [];

  // Use deliberately-invalid field names on each endpoint so the CSRF surface
  // is probed without actually mutating anything. If the server parses the
  // form-urlencoded body, it'll validate-reject (400) not 415.
  const probes = [
    // Profile: no-op change — use current firstName/lastName as "new" values.
    {
      url: "/api/proxy/users/update-profile",
      method: "PATCH",
      form: `firstName=${encodeURIComponent((before as any).firstName)}&lastName=${encodeURIComponent((before as any).lastName)}`,
    },
    // Password change: deliberately wrong current password so it rejects.
    {
      url: "/api/proxy/users/current-user-update-password",
      method: "PATCH",
      form: "currentPassword=WrongWrongWrong&newPassword=WrongWrongWrong123!",
    },
    // Groups create: missing required name so it rejects.
    { url: "/api/proxy/groups", method: "POST", form: "members=" },
    // Roles create: invalid name so it rejects.
    { url: "/api/proxy/roles", method: "POST", form: "" },
    // Settings: fake id so it 404s at routing.
    { url: "/api/proxy/settings/00000000000000000000", method: "PUT", form: "loanFee=0" },
  ];

  for (const p of probes) {
    for (const ct of [
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=----XBoundary",
      "application/json",  // control: what does the same endpoint say with JSON?
    ]) {
      const body =
        ct.startsWith("application/json")
          ? JSON.stringify(Object.fromEntries(new URLSearchParams(p.form)))
          : p.form;
      const r = await api.fetch(p.url, {
        method: p.method,
        data: body,
        headers: { Authorization: `Bearer ${token}`, "content-type": ct },
      });
      rows.push({
        url: p.url,
        method: p.method,
        ct,
        status: r.status(),
        body: (await r.text()).slice(0, 400),
      });
    }
  }

  save("32_form_urlencoded_mutations", rows);
});

// ───────────────────── 33 · Create-Chama wizard walk-through ─────────────────────
test("probe 33 · create-chama wizard (Eugene)", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const network: Array<{ method: string; url: string; status: number | null; reqBody: string | null; respSample: string | null }> = [];
  page.on("requestfinished", async (req) => {
    const rt = req.resourceType();
    if (!["xhr", "fetch"].includes(rt)) return;
    const url = req.url();
    if (!url.includes("/api/proxy/")) return;
    const resp = await req.response();
    let respBody = "";
    try { if (resp) respBody = (await resp.body()).toString("utf8").slice(0, 400); } catch {}
    network.push({
      method: req.method(),
      url,
      status: resp?.status() ?? null,
      reqBody: req.postData() ?? null,
      respSample: respBody,
    });
  });

  await page.goto(`${BASE}/get-started`, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/proxy/users/signin") && r.request().method() === "POST", { timeout: 20_000 }).catch(() => null),
    page.getByRole("button", { name: /log\s*in|sign\s*in/i }).first().click(),
  ]);
  await page.waitForURL((u) => !u.toString().endsWith("/get-started"), { timeout: 15_000 }).catch(() => null);

  await page.goto(`${BASE}/admin/chamas/create`, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(RUN_DIR, "33_step1.png"), fullPage: true }).catch(() => {});

  // Try to fill Step 1 (Basic Info). Use fields we saw on the captured admin profile HTML.
  const uniq = `AuditTestChama-${Date.now()}`;
  const fillAttempts: Array<{ label: string; ok: boolean; err?: string }> = [];
  async function fillByLabel(label: RegExp, value: string) {
    try {
      const input = page.getByLabel(label).first();
      await input.fill(value, { timeout: 5_000 });
      fillAttempts.push({ label: label.source, ok: true });
    } catch (e) {
      fillAttempts.push({ label: label.source, ok: false, err: (e as Error).message.slice(0, 120) });
    }
  }
  await fillByLabel(/group\s*name|chama\s*name|name\s*\*/i, uniq);
  await fillByLabel(/description/i, "Audit probe — safe to delete");

  const nextBtn = async () => {
    const btn = page.getByRole("button", { name: /^next$|continue/i }).first();
    await btn.click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(2000);
  };

  // Step 2 + onwards — best-effort: try to Next through as many steps as the UI allows.
  for (let step = 2; step <= 5; step++) {
    await page.screenshot({ path: path.join(RUN_DIR, `33_step${step}_before.png`), fullPage: true }).catch(() => {});
    await nextBtn();
    await page.screenshot({ path: path.join(RUN_DIR, `33_step${step}_after.png`), fullPage: true }).catch(() => {});
  }

  // Final submit if a submit / finish button exists.
  const submit = page.getByRole("button", { name: /^create$|^finish$|^submit$|^save$/i }).first();
  await submit.click({ timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(RUN_DIR, "33_submit.png"), fullPage: true }).catch(() => {});

  // Cleanup: if a chama with that name was created, DELETE it via the API.
  const api = await request.newContext({ baseURL: BASE });
  const { token } = await loginEugene(api);
  const list = await api.get("/api/proxy/groups", { headers: authHeaders(token) });
  const listJson = (await list.json()) as any;
  const created = (listJson?.data?.groups ?? []).find((g: any) => g.name === uniq);
  let deleteResult: any = null;
  if (created?.id) {
    const del = await api.fetch(`/api/proxy/groups/${created.id}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    deleteResult = { status: del.status(), body: (await del.text()).slice(0, 400), groupId: created.id };
  }

  save("33_create_chama", {
    uniq,
    fillAttempts,
    networkCount: network.length,
    firstTenXhr: network.slice(0, 10),
    cleanupLookupStatus: list.status(),
    createdFound: !!created,
    deleteResult,
  });
  save("33_create_chama_network", network);

  await ctx.close();
});

// ───────────────────── 34 · supply-chain fingerprints (static) ─────────────────────
test("probe 34 · supply-chain fingerprints from captured bundles", async () => {
  const bundleDir = path.resolve(__dirname, "..", "probes", "bundles");
  const files = fs.readdirSync(bundleDir).filter((f) => f.endsWith(".js"));
  const patterns: Array<{ name: string; re: RegExp }> = [
    { name: "next-version",      re: /"next\/dist\/[^"]+"|__NEXT_DATA__|buildId/ },
    { name: "react-version",     re: /"react"\s*:\s*"(\d+\.\d+\.[\d.]+)"|React\.version\s*=\s*"(\d+\.\d+\.[\d.]+)"|__REACT_VERSION__/ },
    { name: "axios-marker",      re: /axios\/lib\/[^"]+|"axios"\s*,\s*"(\d+\.\d+\.\d+)"/ },
    { name: "socket.io-client",  re: /socket\.io-client|socket\.io-parser|engine\.io-client/ },
    { name: "lodash",            re: /lodash|"lodash"\s*,/ },
    { name: "moment",            re: /moment\/locale|moment\/moment/ },
    { name: "date-fns",          re: /date-fns\/|"date-fns"/ },
    { name: "redux-toolkit",     re: /redux-toolkit|@reduxjs\/toolkit/ },
    { name: "@tanstack/react-query", re: /@tanstack\/react-query|queryClient/ },
    { name: "zod",               re: /zod\/lib|ZodError|z\.object/ },
    { name: "jsonwebtoken",      re: /jsonwebtoken|jwt\.sign|jwt\.verify/ },
    { name: "formik",            re: /formik/ },
    { name: "tailwind",          re: /tailwindcss/ },
    { name: "dayjs",             re: /dayjs/ },
  ];
  const results: Record<string, string[]> = {};
  for (const { name } of patterns) results[name] = [];
  for (const f of files) {
    const bytes = fs.readFileSync(path.join(bundleDir, f), "utf8");
    for (const { name, re } of patterns) {
      const m = bytes.match(re);
      if (m) results[name].push(`${f}: ${m[0].slice(0, 120)}`);
    }
  }

  // Also look for a few well-known version constants (heuristic).
  const versionHints: Array<{ name: string; value: string }> = [];
  for (const f of files) {
    const bytes = fs.readFileSync(path.join(bundleDir, f), "utf8");
    // React 18 is the most likely version; look for the expected marker.
    const rv = bytes.match(/"react-dom":"(\d+\.\d+\.\d+)"|"react":"(\d+\.\d+\.\d+)"/);
    if (rv) versionHints.push({ name: `react/react-dom in ${f}`, value: rv[0] });
    const next = bytes.match(/__NEXT_VERSION__="(\d+\.\d+\.\d+)"|next\/dist\/build\/([^"]+)/);
    if (next) versionHints.push({ name: `next in ${f}`, value: next[0].slice(0, 80) });
    const socketv = bytes.match(/socket\.io-client\/(\d+\.\d+\.\d+)|socket\.io-parser\/(\d+\.\d+\.\d+)/);
    if (socketv) versionHints.push({ name: `socket.io in ${f}`, value: socketv[0] });
    const axiosv = bytes.match(/axios\/(\d+\.\d+\.\d+)\//);
    if (axiosv) versionHints.push({ name: `axios in ${f}`, value: axiosv[0] });
  }

  save("34_supply_chain_scan", { results, versionHints });
});
