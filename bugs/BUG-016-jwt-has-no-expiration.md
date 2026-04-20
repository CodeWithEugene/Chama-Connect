<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-016 — JWT has no expiration — stolen tokens are valid forever

| Field | Value |
|---|---|
| Severity | Critical (security) |
| Surface | Auth / API |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright recon — decoded the signin token |

## Evidence

The JWT returned by `POST /api/proxy/users/signin` (and mirrored into the `session` cookie) decodes to:

```json
{
  "id": "69ca9583185c4debc8e94dc5",
  "phone": "+254746152008",
  "firstName": "Eugene",
  "lastName": "Mutembei",
  "roleId": "69c50c8a38f08070a83bd35b",
  "email": "eugenegabriel.ke@gmail.com",
  "role": { "id": "69c50c8a38f08070a83bd35b", "name": "User" },
  "isSuperadmin": false,
  "userType": "REGULAR",
  "iat": 1776678191
}
```

Header: `{"alg":"HS256","typ":"JWT"}`.

**No `exp` claim. No `nbf`. No `jti`. No `iss`. No `aud`.** Only `iat` is set.

Full capture: `recon/artifacts/2026-04-20T09-40-50-508Z/signin_response.json`.

## User impact

1. **Never-expiring token.** The JWT is valid for eternity. A user who logs in once and leaves the session on a shared / stolen laptop is permanently reachable by whoever gets the token afterwards.
2. **No revocation path.** There is no server-side session registry to delete, no `jti` to blacklist, no `exp` to wait out. The *only* way to invalidate this token is to rotate `JWT_SECRET` — which logs out **every user** on the platform simultaneously.
3. **Amplifies BUG-013.** That bug already exfiltrates the token via the response body. A one-time XSS → one-time token capture → **permanent** account takeover. With an `exp` of even 7 days, the attack window would be bounded; with no `exp`, it is not.
4. **No `jti` means no replay detection.** If a token is captured (SDK log, browser extension, proxy log, sentry trace), the server cannot distinguish its own issuance from a stolen copy.
5. **No `iss` / `aud` means cross-service misuse** is easy the moment MUIAA adds a second product (e.g. a SACCO portal using the same secret). The same token works across both.

For a product that holds chama contribution balances this is the single most dangerous auth defect on the site.

## Root cause

Classic `jsonwebtoken` call with defaults:

```ts
// services/auth.ts — inferred
jwt.sign({ id, email, phone, roleId, role, firstName, lastName, isSuperadmin, userType }, JWT_SECRET);
// no options object → no expiresIn, no jwtid, no issuer, no audience
```

The signed payload also embeds `firstName`, `lastName`, `phone`, and the role object directly — bloats the token, leaks PII into logs that capture auth headers, and ensures stale names persist in the token until secret rotation.

## Proposed fix

1. **Add `expiresIn` immediately.** Shortest safe value for a financial product is 15–30 minutes for the access token; pair it with a refresh token rotated on each use.

```ts
const accessToken = jwt.sign(
  { sub: user.id, role: user.role.name, userType: user.userType, isSuperadmin: user.isSuperadmin },
  JWT_SECRET,
  {
    algorithm: "HS256",
    expiresIn: "30m",
    issuer: "chamaconnect.io",
    audience: "chamaconnect-web",
    jwtid: crypto.randomUUID(),
    notBefore: 0,
  }
);

const refreshToken = crypto.randomBytes(64).toString("base64url");
await db.sessions.insert({ jti: refreshToken, userId: user.id, expiresAt: now + 30*24*3600*1000, revoked: false });
```

2. **Strip PII from the token.** `firstName`, `lastName`, `email`, `phone`, the role object — none of this needs to be in the JWT. Put only `sub` (user id), coarse authz claims (`role`, `isSuperadmin`, `userType`), and standard claims.

3. **Add a `jti` server-side table.** Every access token carries a `jti`; a logout endpoint flips the `revoked` flag. Middleware checks both signature and revocation.

4. **Add `iss` and `aud`** and verify them on every request. Future services (mobile app, admin portal, partner API) must each request a different `aud` and refuse tokens minted for another one.

5. **Add `exp` enforcement to the middleware** — reject any token older than `iat + maxAge` even if `exp` is absent, as a transition safety net.

6. **Rotate `JWT_SECRET` once the fix ships** to invalidate every existing never-expiring token in circulation. Users will be logged out; that is the right outcome.

## Verification

- `curl -X POST /api/proxy/users/signin ... | jq -r .data.token | awk -F. '{print $2}' | base64 -d | jq` shows an `exp` claim set to `iat + 1800` (30 min).
- After the access token expires, a `GET /api/proxy/users/current-user` with only that token returns 401; the refresh-token flow restores the session without re-prompting.
- Security regression test:

```ts
test("signin JWT has exp, iss, aud, jti", async ({ request }) => {
  const r = await request.post("/api/proxy/users/signin", { data: { email, password } });
  const { data } = await r.json();
  const payload = JSON.parse(Buffer.from(data.token.split(".")[1], "base64url").toString());
  for (const k of ["exp", "iat", "iss", "aud", "jti"]) expect(payload).toHaveProperty(k);
  expect(payload.exp - payload.iat).toBeLessThanOrEqual(1800);
  for (const leaked of ["firstName", "lastName", "phone", "email"]) expect(payload).not.toHaveProperty(leaked);
});
```
