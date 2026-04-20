<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-013 — JWT returned in the signin response body (also set as cookie)

| Field | Value |
|---|---|
| Severity | High (security) |
| Surface | Auth / API |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright recon |

## Evidence

`POST /api/proxy/users/signin` response body:

```json
{
  "message": "User Created",
  "status": "success",
  "data": {
    "user": { ... },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."   ← raw JWT
  }
}
```

Full capture: `recon/artifacts/2026-04-20T08-22-01-022Z/signin_response.json`.

The platform *also* calls `POST /api/auth/session` right after, which sets the JWT as an httpOnly cookie (good). So the token is being delivered twice — once securely (cookie), once as plain JSON accessible to any JS in the page.

## User impact

The token is the keys to the kingdom — with it, anything the user can do in the platform, an attacker can do. Handing the raw token to client-side JS creates an XSS-to-takeover path:

1. A single XSS anywhere on the platform (contact form, profile name, chama description) can `fetch('/api/proxy/users/signin', ...)` using the user's own cookies and then read `response.data.token` — bypassing the httpOnly protection entirely.
2. The token is long-lived (JWT, not opaque session) — revoking it requires a secret rotation, not just deleting a DB row.
3. Third-party SDKs (analytics, feature-flag, session-replay) that log network responses may inadvertently capture the token in their telemetry. Several common SDKs (Sentry, LogRocket, etc.) capture response bodies by default.

Essentially: the httpOnly cookie gives you defense-in-depth against XSS — and then the response body throws it away.

## Root cause

Classic "belt and suspenders" gone wrong. The original codebase probably returned the token in the body, then later added httpOnly-cookie support without removing the body field. Both paths still run.

## Proposed fix

```ts
// users.controller.ts
const token = signJwt(user);
res.cookie("session", token, {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  maxAge: 7 * 24 * 3600 * 1000,
});
return res.json({
  message: "Login successful",
  status: "success",
  data: { user },              // ← no token field
});
```

And in the client:

```ts
// Remove every `data.token` read — rely on cookies + a same-origin /api/auth/token GET that returns `{ ok: true }` instead of the raw token.
```

If backward compatibility is needed (a mobile app reads the body), gate the body-returned token behind a `X-Client-Type: native` header and **only** return it for that header.

## Verification

- `curl -X POST /api/proxy/users/signin` → response body has no `token` field, but `Set-Cookie: session=...` header is present.
- Front-end continues to work (the recon-captured flow already hits `/api/auth/session` via cookies).
- Add a security test: assert that no response body on any route contains a string matching `/eyJ[A-Za-z0-9_-]+\./` (JWT prefix).
