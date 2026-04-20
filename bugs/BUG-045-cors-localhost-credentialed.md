<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-045 — CORS misconfiguration: `localhost:3000` receives duplicate `Access-Control-Allow-Origin` + `Access-Control-Allow-Credentials` headers

| Field | Value |
|---|---|
| Severity | High (CORS misconfiguration enabling credentialed cross-origin access from localhost) |
| Surface | API / headers |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

For every non-`chamaconnect.io` origin the API correctly returns `access-control-allow-origin: https://chamaconnect.io` (the canonical origin, not the requester's). However, `http://localhost:3000` triggers anomalous behaviour:

```
Request:  GET /api/proxy/users/current-user
          Origin: http://localhost:3000
          Authorization: Bearer <user token>

Response headers:
  vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
  vary: Origin
  access-control-allow-credentials: true, true
  access-control-allow-headers: Origin, X-Requested-With, Content-Type, Accept, Authorization
  access-control-allow-methods: GET, POST, PUT, DELETE, PATCH, OPTIONS
  access-control-allow-origin: http://localhost:3000, https://chamaconnect.io
```

Two problems:

1. **Duplicate `Access-Control-Allow-Origin` header.** RFC 7230 §3.2.2 permits multiple header values, but the browser interprets `ACAO: a, b` as two origin values. Chrome and Firefox differ on which one "wins" — in Chromium the first value is used, meaning `http://localhost:3000` is the reflected ACAO. Combined with `ACAC: true`, JavaScript from any `localhost:3000` context (browser extension, local HTML file loaded from a web server on port 3000, any npm dev server) can make **authenticated credentialed requests** to the production API and receive sensitive data.

2. **Duplicate `Access-Control-Allow-Credentials: true, true`.** The header has two `true` values — this is also a protocol violation. Some browsers treat the multi-value header as `false` (since it doesn't equal the single string `"true"`), breaking legitimate dev flows. Others ignore the duplication and allow it.

```bash
# Proof: from a localhost:3000 context, a fetch like this works:
fetch('https://chamaconnect.io/api/proxy/users/current-user', {
  credentials: 'include',   // or include Authorization header from localStorage
})
# Returns 200 with the logged-in user's full profile
```

Real-world exploit: a malicious browser extension that injects a script on any page, or a malicious local app on port 3000, can silently exfiltrate the victim's transactions, group memberships, PII, and M-Pesa credentials without user interaction — if the victim is currently logged in.

## Root cause

Two CORS middleware layers are running simultaneously: Next.js's built-in CORS handler (configured in `next.config.mjs` or middleware.ts) and the Express/backend CORS middleware forwarded from the upstream. Both are inserting `ACAO` and `ACAC` headers, and one of them reflects `localhost` origins. The conflict produces duplicate headers.

## Proposed fix

1. **Single source of truth for CORS.** Pick one layer — preferably the Next.js edge middleware — and disable CORS on the upstream backend (it should only accept requests from the BFF's internal IP anyway, per BUG-033 fix).

2. **Never reflect the `Origin` header back as `ACAO`** unless the origin is on a known allow-list:

```ts
// middleware.ts  (or next.config.mjs headers)
const ALLOWED_ORIGINS = new Set([
  'https://chamaconnect.io',
  'https://www.chamaconnect.io',
  // localhost only in development:
  ...(process.env.NODE_ENV === 'development' ? ['http://localhost:3000', 'http://localhost:3100'] : []),
]);

export function middleware(req: NextRequest) {
  const origin = req.headers.get('origin') ?? '';
  const acao = ALLOWED_ORIGINS.has(origin) ? origin : 'https://chamaconnect.io';
  const resp = NextResponse.next();
  resp.headers.set('Access-Control-Allow-Origin', acao);
  resp.headers.set('Access-Control-Allow-Credentials', 'true');
  resp.headers.set('Vary', 'Origin');
  return resp;
}
```

3. **Do not allow localhost in production CORS.** The `NODE_ENV === 'development'` guard above means localhost is only permitted when the server is running locally, never in the deployed version.

4. Confirm the upstream Express also stops setting CORS headers once Next.js is the sole CORS layer.

## Verification

1. `curl -H 'Origin: http://localhost:3000' https://chamaconnect.io/api/proxy/users/current-user` → `access-control-allow-origin: https://chamaconnect.io` (not localhost).
2. Exactly one `access-control-allow-credentials: true` header in every response.
3. `fetch('https://chamaconnect.io/api/...', { credentials:'include' })` from `http://localhost:3000` context → CORS error in browser, not 200.
4. Automated test in `/recon/tests/cors.spec.ts`.
