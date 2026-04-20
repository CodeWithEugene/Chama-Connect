<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-005 — 2FA code exists but is never surfaced; no phone OTP / social sign-in

| Field | Value |
|---|---|
| Severity | High |
| Surface | Auth / security |
| Status | Open (scope updated 2026-04-20 after authenticated recon) |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl of `/get-started`) + Playwright recon of bundle |

## Update after authenticated recon

Reverse-engineering the login bundle (`/_next/static/chunks/5ce392a8816373c7.js`) shows the code *does* branch on a `requires2FA` flag returned by the server and pushes to `/auth/2fa-challenge` when it's set:

```js
// excerpt from the signin handler
if (o.requires2FA) { r(false); a.push("/auth/2fa-challenge"); return; }
```

So 2FA plumbing exists server-side. But:
1. There is no UI anywhere in the dashboard to **enable** 2FA for your account (audited `/admin/*` routes — none surfaces a 2FA settings page).
2. The only factor visible to users is email + password.
3. No phone-OTP, no TOTP, no WebAuthn, no social login.

Net effect: users cannot turn on 2FA, so the `requires2FA` branch never fires in practice. Security is equivalent to email + password only.

## Evidence

From `/tmp/cc_start.html`:

```html
<form class="space-y-4">
  <input aria-label="Email"    type="email"    placeholder="thekimpeople@gmail.com"/>
  <input aria-label="Password" type="password" placeholder="•••••••••••••"/>
  <!-- Remember me + Forgot password -->
  <button type="submit">Login</button>
</form>
```

That is the entire auth surface. No TOTP, no SMS OTP, no WebAuthn, no `Sign in with Google`, no magic-link fallback.

## User impact

- **Security:** ChamaConnect holds group-level financial data — contributions, loans, payout authorisation. A single password phish empties a chama's ledger. Kenya has had documented incidents (FSD Kenya reports 13% chama embezzlement); the fact that chama members tend to reuse passwords from WhatsApp / banking apps makes this worse.
- **Compliance:** ODPC (Kenya's Office of the Data Protection Commissioner) expects "reasonable" authentication for platforms processing financial data under the Data Protection Act 2019. Password-only is increasingly hard to defend.
- **Access:** No phone-OTP means rural members without email (or who forget the Gmail password they made at a cyber café) are permanently locked out. A phone number is the one stable identifier a Kenyan chama member has.

## Root cause

MVP ships with email+password only. `AuthProvider` component in the root layout handles a single `/api/login` call.

## Proposed fix

Shipping full passkeys is out of scope for a 4-day hackathon, but the following changes deliver 80% of the value in < 1 day:

1. **Add phone OTP as primary factor** (Kenya-first):
   - Register stores `msisdn` in E.164 (`+2547...`).
   - `POST /api/auth/otp/request` → Africa's Talking SMS with a 6-digit code + 5-min TTL in Redis.
   - `POST /api/auth/otp/verify` → on success issue the session cookie.
   - Keep password as a second, optional factor.

2. **Add TOTP 2FA for admins** (treasurers / chama chairs):
   - Use `otplib` + QR code from `qrcode`.
   - Store encrypted shared secret in user row.
   - Force on roles with payout or member-removal permissions.

3. **Reduce the `thekimpeople@gmail.com` placeholder** (minor — but shipping a real-looking email as placeholder is sloppy and borderline PII).

4. **Implement rate limiting + generic error messages** on `/api/login` so failed attempts don't leak which emails are registered.

See `chamapay/apps/web/app/(auth)/otp` in this repo for a working reference implementation.

## Verification

- A user can register with a phone number, receive an SMS, and log in without a password.
- An admin role cannot log in without TOTP after 2FA is enforced.
- `wrk -t4 -c100 -d30s -s post.lua https://chamaconnect.io/api/login` — rate limit kicks in within N attempts.
- OWASP ZAP scan shows no enumeration via error message differences.
