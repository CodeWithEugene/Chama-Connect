<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-073 — Email verification is enforced on signup but bypassable on email change (new evidence strengthening BUG-063)

| Field | Value |
|---|---|
| Severity | High (amplifies BUG-063 Critical ATO) |
| Surface | Auth / profile API |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright audit pass 2 side-effect |
| Related | **BUG-063** (email change w/o re-verification), **BUG-005** (2FA unreachable) |

## Evidence

Audit pass 2 tried to create fresh probe accounts. Every one was accepted (`201`) but the immediate `signin` attempt returned:

```http
POST /api/proxy/users/signin
→ 400
{
  "message": "Please verify your email before signing in",
  "status":  "error",
  "data": {
    "requiresEmailVerification": true,
    "email": "audit2-1776686692225-t3k0@probe.local"
  }
}
```

Raw capture: `recon/artifacts/audit2-2026-04-20T12-04-52-213Z/00_probe_account_debug.json`. This behaviour is observed for every fresh account — the backend does enforce email verification at signup time.

**But** BUG-063 demonstrated that once a user is signed in, `PATCH /api/proxy/users/update-profile` accepts any `email` value without asking for verification of the new address. Probe 15 + the restore flow both succeeded in swapping the email on Eugene's account with zero re-verification.

The contradiction is what matters:

| Moment in account lifecycle | Email verification required? |
|---|---|
| `POST /signup` → first `POST /signin` | **Yes** — `400 "Please verify your email before signing in"` |
| `PATCH /users/update-profile  {email:"anything"}` | **No** — 200, `emailVerified` stays `true` for the new address |

## User impact

The signup-time gate tells us the platform's designers *did* believe users must prove control of an email address before they can use the system. The PATCH-time bypass means that belief is enforced exactly once — at the least-useful moment. After that, any one-time JWT leak (BUG-013 response body, BUG-046 no revocation, BUG-011 localhost websocket with token-in-url, BUG-050 stored XSS) becomes a permanent account takeover (see BUG-063's full attack chain).

This is the hardest kind of security bug to catch in code review because both halves look correct in isolation:

- **signup.ts** looks correct: sends OTP, blocks signin until verified.
- **update-profile.ts** looks correct: authenticated user, mass-assign allowed fields, save.

Neither author is "wrong"; but together they invalidate each other.

## Root cause

Email verification is a **creation-time precondition**, not a **mutation-time invariant**. The fix is to treat the user's current email as a guarded field — any change must go through the same OTP / link flow that signup used.

## Proposed fix

This is the same fix as BUG-063 — separate "pending email" from "verified email" in the user model, add a `/request-email-change → /confirm-email-change` flow, and reset `emailVerified` to `false` on email change. Re-stated here because BUG-063 is phrased as "critical ATO" but the root cause — inconsistency between signup-time and mutation-time verification — deserves its own ticket so it doesn't get lost in the ATO narrative.

Concretely, to prove consistency:

```ts
// Invariant: for every (user, email) tuple that the system treats as
// "the user's verified address", there must exist an audit entry proving
// the user clicked a link sent to that address within the last 180 days.
```

The signup flow upholds this invariant. The `update-profile` flow violates it. Any fix that re-asserts it everywhere closes BUG-063, BUG-073, and the class of bug they represent.

## Verification

- `POST /signup` with new email → `400` on subsequent signin until OTP is completed (unchanged — this half already works).
- `PATCH /users/update-profile  {email: "new@x"}` → `202 Accepted`, `{pendingEmail: "new@x"}`, a verification email / SMS is sent to the **new** address, and `emailVerified` on the old address stays `true` until the link is clicked.
- Clicking the verification link → `user.email = "new@x"`, `emailVerified = true`, old address is notified with an "undo" link, all outstanding JWTs for this user are invalidated (covered by BUG-046's revocation list).
- Attempting to sign in with the new email before the link is clicked → same `400 "Please verify your email before signing in"` gate the signup flow uses.

Side-effect housekeeping: several probe accounts created in audit-pass-1 and audit-pass-2 are stuck in the unverified state and should be purged:

- `race-1776684514414@probe.local`
- `pw-1776684548453-8yd1d0@probe.local`
- `pw-1776684549177-addez3@probe.local`
- `pw-1776684550885-qs1rmj@probe.local`
- `pp-1776684545310@probe.local`
- `audit2-1776686692225-t3k0@probe.local`
