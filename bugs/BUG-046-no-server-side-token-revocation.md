<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-046 — JWT not invalidated on logout: stolen tokens remain valid for up to 7 days

| Field | Value |
|---|---|
| Severity | High (session management — token cannot be revoked) |
| Surface | Auth / API |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl + Playwright) |

## Evidence

**Logout flow:**
1. `DELETE /api/auth/session` — Next.js clears the `auth_token` cookie. Response: `{"message":"Session cleared"}`.
2. **Immediately after logout**, the original Bearer token from before logout is tested:

```bash
$ curl -sS -H "authorization: Bearer $TOKEN_BEFORE_LOGOUT" \
    https://chamaconnect.io/api/proxy/users/current-user
{"message":"Successfully  retrieved logged in user","status":"success","data":{ ... }}
# HTTP 200 — token still valid even after "logout"
```

3. **No `/api/proxy/users/logout`** endpoint exists — confirmed 404.
4. **No `exp` claim in the JWT** (BUG-016) — the token never expires on its own.
5. **Cookie `Max-Age: 604800`** (7 days) — the httpOnly cookie is the only time-bound element, but the underlying JWT has no expiry and the backend has no token blocklist.

Net result: "logging out" only removes the browser cookie. If the token was previously:
- Returned in the signin response body (BUG-013),
- Stored in `localStorage` by a frontend bug,
- Intercepted by a MITM on a non-HSTS network,
- Extracted by BUG-028/042 tools from another session,

…then the attacker retains permanent access to the account. There is no way for the real user or a platform admin to revoke a live token.

## User impact

This is a direct consequence of BUG-016 (no `exp` claim) compounded by the absence of a server-side blocklist:

- A user who suspects their account was compromised (e.g. got a password-reset notification they didn't trigger) cannot lock out the attacker by changing their password or logging out — the attacker's stolen token stays valid indefinitely.
- A platform admin who deactivates a user (`isActive: false`) does not invalidate outstanding tokens if the middleware doesn't re-check `isActive` on every request.
- Any device theft, session handover, or XSS incident leaves the victim with no recovery path short of contacting support and having the account deleted.

On a financial platform where tokens give access to contribution records, approvals, and (via BUG-027/040) platform-wide configuration mutations, permanent token validity is an existential risk.

## Root cause

The backend is a stateless JWT verifier with no token blocklist (Redis SET or DB table). The Next.js layer's "logout" only deletes the browser cookie — it cannot invalidate what the backend has already signed. Combined with no `exp` claim, there is nothing to time-box the token's validity.

## Proposed fix

Three changes needed together:

1. **Add `exp` claim to every issued JWT** (fixes BUG-016 — required here):

```ts
const token = jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '15m' });
```

2. **Add a refresh-token flow** so users don't have to re-login every 15 minutes:

```ts
// POST /api/proxy/auth/refresh
// Validates a long-lived (7-day, httpOnly, Secure, SameSite=Strict) refresh token
// Returns a new 15-min access token
// Invalidates the old refresh token (one-time use)
```

3. **Maintain a token blocklist for logout and forced revocation:**

```ts
// On logout — add jti (from BUG-016 fix, add jti claim) to a Redis SET with TTL = exp - now
await redis.set(`revoked:${payload.jti}`, '1', 'EX', ttlSeconds);

// On every authenticated request — check the blocklist
const revoked = await redis.exists(`revoked:${payload.jti}`);
if (revoked) return unauthorized(res, 'Token has been revoked');
```

4. **On password change / account deactivation**: revoke all outstanding tokens for that user (store `userId → tokenIssuedBefore` timestamp in DB; any token with `iat < issuedBefore` is rejected).

## Verification

1. Sign in, capture the Bearer token. Sign out. Try the old token → `401 Token has been revoked`.
2. Sign in on device A. Change password on device B. Try the device-A token → `401`.
3. Admin deactivates user. User's outstanding token → `401` with `"Account deactivated"`.
4. Regression test in `/recon/tests/token-revocation.spec.ts`.
