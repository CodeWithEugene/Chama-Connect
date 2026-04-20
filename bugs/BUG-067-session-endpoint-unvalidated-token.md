<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-067 — `POST /api/auth/session` sets the `auth_token` cookie to **any** supplied value without verifying it

| Field | Value |
|---|---|
| Severity | Medium |
| Surface | Auth / Next.js session bridge |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright audit probe 04 |
| CWE | CWE-384 (Session Fixation), CWE-345 (Insufficient Verification of Data Authenticity) |

## Evidence

Captured at `recon/artifacts/audit-2026-04-20T11-27-52-385Z/04_csrf_auth.json`. The Next.js bridge route `POST /api/auth/session` happily returns `200 {"message":"Session created"}` when given a payload like:

```http
POST /api/auth/session HTTP/1.1
Host: chamaconnect.io
Origin: https://evil.example
Referer: https://evil.example/evil.html
Content-Type: application/json

{"token":"eyJ0ZXN0IjoidGVzdCJ9"}
```

`eyJ0ZXN0IjoidGVzdCJ9` decodes to `{"test":"test"}` — not a real JWT, no signature, no claims. The endpoint still replies `{"message":"Session created"}` and sets an `auth_token` cookie carrying that literal string.

Three observations:

1. **No signature verification.** The route does not call `jwt.verify(token, SECRET)` before trusting the value. Any value — including `"attacker-chosen-string"` — becomes the session cookie.
2. **No Origin / Referer check.** Requests from `evil.example`, `null`, and `http://localhost:1337` all succeed at the route level. The returned `Access-Control-Allow-Origin` is empty, so a **browser** fetch from those origins would still be blocked from reading the response — but the cookie set by a non-preflighted or same-site-follow-up request would still land.
3. **Cookie flags are good** (BUG-045 has a mitigation: `auth_token` is `Secure; HttpOnly; SameSite=Strict` per the cookie audit, `recon/artifacts/audit-…/05_cookies.json`). SameSite=Strict does mitigate the classic browser session-fixation path, but does **not** remove the server-side design flaw.

## User impact

Two harms, in descending likelihood:

1. **Weapon in multi-step attacks.** Combined with any XSS (e.g. BUG-050 — stored XSS in group name), the attacker can run `fetch('/api/auth/session', { method: 'POST', credentials: 'include', body: JSON.stringify({ token: attackerToken })})` from the victim's browser on `chamaconnect.io`, **immediately overwriting the victim's cookie with the attacker's session**. From there the victim's interactions happen in the attacker's account (chama membership, M-Pesa collection point edits, etc.). SameSite=Strict does **not** help here because the XSS runs on `chamaconnect.io` itself.
2. **Silent takeover of stale tabs.** An attacker who phishes a valid token from a user can push that token into any still-open chamaconnect.io tab they share a browser with (family device, cyber-café machine) via a crafted URL that triggers the endpoint through a top-level POST.

Both reduce to: *trusting user-supplied bytes to be a verified JWT before promoting them to the cookie*.

## Root cause

`/api/auth/session/route.ts` (App Router) reads `req.json().token` and writes it straight to `cookies().set("auth_token", token, …)`. The route was intended as a bridge between the React AuthProvider (which receives the token in the signin response body — see BUG-013) and the httpOnly cookie, but never learned to verify the value before accepting it.

## Proposed fix

1. **Verify the JWT before persisting the cookie.** Reject any token that doesn't validate against the backend's shared secret / JWKS:

   ```ts
   // app/api/auth/session/route.ts
   import { cookies } from "next/headers";
   import { jwtVerify } from "jose";
   import { NextResponse } from "next/server";

   export async function POST(req: Request) {
     const { token } = await req.json().catch(() => ({}));
     if (typeof token !== "string") {
       return NextResponse.json({ error: "invalid token" }, { status: 400 });
     }
     try {
       await jwtVerify(token, new TextEncoder().encode(process.env.JWT_SECRET!));
     } catch {
       return NextResponse.json({ error: "invalid token" }, { status: 401 });
     }
     cookies().set("auth_token", token, {
       httpOnly: true, secure: true, sameSite: "strict", path: "/",
       maxAge: 7 * 24 * 3600,
     });
     return NextResponse.json({ ok: true });
   }
   ```

2. **Origin allowlist** on this route specifically, as defence-in-depth:

   ```ts
   const origin = req.headers.get("origin") ?? "";
   const allowed = new Set([process.env.PUBLIC_BASE_URL!, "null"]); // same-origin only
   if (origin && !allowed.has(origin)) return new Response(null, { status: 403 });
   ```

3. **Better still: remove this bridge entirely.** Per BUG-013, the response body should not contain the token at all — if the backend sets the httpOnly cookie on the signin response directly (via `Set-Cookie`), the Next.js route is unnecessary. That eliminates the fixation surface by design.

4. **Revocation list** (covered by BUG-046) — once the cookie is invalidated on logout, a re-played token from this route would fail the verification check in step 1.

## Verification

- `POST /api/auth/session  body={"token":"not-a-jwt"}`         → 400 `invalid token`, no `Set-Cookie`.
- `POST … body={"token":"eyJ...<signed-with-other-secret>"}`   → 401 `invalid token`.
- `POST … body={"token":<just-rotated-valid-jwt>}`             → 200, cookie set.
- From evil origin (curl with `Origin: https://evil.example`) → 403.
- Security test in CI that asserts no un-verified-token cookie was issued on 1000 randomised payloads.
