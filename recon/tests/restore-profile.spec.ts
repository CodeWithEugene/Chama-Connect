/**
 * One-shot restore: undo the side-effect of probe 15 (audit-extended),
 * which PATCH'd /api/proxy/users/update-profile with {email:"pwned-...",
 * firstName:"Hack", lastName:"Hack"}.
 *
 * We log in with the currently-set (pwned) email + the original password
 * (probe 15 didn't touch the password), then PATCH back to the original
 * values from .env + from the signin capture.
 */

import { test, expect, request } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const ORIGINAL_EMAIL = process.env.email!;
const ORIGINAL_PASSWORD = process.env.password!;
const ORIGINAL_FIRST = "Eugene";
const ORIGINAL_LAST = "Mutembei";

test("restore profile after probe 15", async () => {
  const api = await request.newContext({ baseURL: "https://chamaconnect.io" });

  // Find the email we are currently registered under by scanning probe 15's artifact
  const auditDirs = fs
    .readdirSync(path.resolve(__dirname, "..", "artifacts"))
    .filter((d) => d.startsWith("audit-"))
    .sort()
    .reverse();
  let pwnedEmail: string | null = null;
  for (const d of auditDirs) {
    const p = path.resolve(__dirname, "..", "artifacts", d, "15_email_change.json");
    if (!fs.existsSync(p)) continue;
    const rows = JSON.parse(fs.readFileSync(p, "utf8")) as Array<{ method: string; status: number; body: string }>;
    const hit = rows.find((r) => r.method === "PATCH" && r.status === 200);
    if (hit) {
      const m = /"email":"([^"]+@probe\.local)"/.exec(hit.body);
      if (m) {
        pwnedEmail = m[1];
        break;
      }
    }
  }

  const candidates = pwnedEmail
    ? [pwnedEmail, ORIGINAL_EMAIL]
    : [ORIGINAL_EMAIL];

  let token: string | null = null;
  let currentEmail: string | null = null;
  for (const email of candidates) {
    const r = await api.post("/api/proxy/users/signin", {
      data: { email, password: ORIGINAL_PASSWORD },
      headers: { "content-type": "application/json" },
    });
    if (r.ok()) {
      const j = (await r.json()) as any;
      token = j?.data?.token;
      currentEmail = j?.data?.user?.email;
      console.log(`[restore] signed in with ${email}; current email = ${currentEmail}`);
      break;
    } else {
      console.log(`[restore] ${email} → ${r.status()} ${(await r.text()).slice(0, 100)}`);
    }
  }

  expect(token).toBeTruthy();

  const resp = await api.fetch("/api/proxy/users/update-profile", {
    method: "PATCH",
    data: JSON.stringify({
      email: ORIGINAL_EMAIL,
      firstName: ORIGINAL_FIRST,
      lastName: ORIGINAL_LAST,
    }),
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });
  const body = await resp.text();
  console.log(`[restore] PATCH status ${resp.status()}; body = ${body.slice(0, 400)}`);
  expect(resp.ok()).toBeTruthy();

  // Verify
  const verify = await api.get("/api/proxy/users/current-user", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const vj = (await verify.json()) as any;
  console.log(
    `[restore] verify: email=${vj?.data?.email} firstName=${vj?.data?.firstName} lastName=${vj?.data?.lastName}`
  );
  expect(vj?.data?.email).toBe(ORIGINAL_EMAIL);
  expect(vj?.data?.firstName).toBe(ORIGINAL_FIRST);
  expect(vj?.data?.lastName).toBe(ORIGINAL_LAST);
});
