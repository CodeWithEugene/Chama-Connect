<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-061 — HSTS Header Missing on All HTML Pages (Login, Admin, Homepage)

| Field | Value |
|---|---|
| Severity | High |
| Surface | Web → all HTML pages (`/`, `/get-started`, `/admin/*`) |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual header audit |

## Evidence

The `Strict-Transport-Security` (HSTS) header is present on API JSON responses but **absent from all HTML pages**, including the login page and admin dashboard:

```bash
# API endpoint — HSTS present ✓
curl -sI https://chamaconnect.io/api/proxy/users/current-user | grep -i strict
# strict-transport-security: max-age=31536000; includeSubDomains

# Homepage — HSTS MISSING ✗
curl -sI https://chamaconnect.io/ | grep -i strict
# (no output)

# Login page — HSTS MISSING ✗
curl -sI https://chamaconnect.io/get-started | grep -i strict
# (no output)

# Admin dashboard — HSTS MISSING ✗
curl -sI https://chamaconnect.io/admin/dashboard | grep -i strict
# (no output)
```

Full homepage response headers show no HSTS:
```
HTTP/2 200
cache-control: s-maxage=31536000
x-powered-by: Next.js
server: cloudflare
# ← no strict-transport-security
```

## User impact

Without HSTS on HTML pages, users who type `chamaconnect.io` into a browser (without `https://`) can be silently redirected to an HTTP version of the site by an attacker performing an SSL stripping attack on the same Wi-Fi network. In Kenya, where shared hotspots and mobile data tethering are common in chama meeting environments, this is a realistic threat. An attacker on the same network can intercept the unencrypted login form submission, capturing the user's email and password in plaintext. For a platform managing real money and M-Pesa credentials, this is a high-severity risk.

HSTS tells browsers to **always** use HTTPS for the domain, preventing any downgrade, even on the very first HTTP request (if the domain is on the HSTS preload list).

## Root cause

The Next.js server (or Cloudflare configuration) only sets `Strict-Transport-Security` on API route responses (likely because those routes pass through a different Express/backend middleware that adds the header), but the Next.js page renders for HTML responses do not set this header. The HSTS header must be set on **all** responses, especially the main page HTML that users load when navigating to the site.

## Proposed fix

**Option A: Add HSTS via `next.config.mjs` headers:**
```js
// next.config.mjs
const nextConfig = {
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ];
  },
};
export default nextConfig;
```

**Option B: Set HSTS in Next.js middleware:**
```typescript
// middleware.ts
import { NextResponse } from 'next/server';
export function middleware(req) {
  const res = NextResponse.next();
  res.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  return res;
}
```

**Option C (preferred): Enable HSTS via Cloudflare Dashboard → SSL/TLS → Edge Certificates → HTTP Strict Transport Security (HSTS).**

After deploying with `max-age=63072000; includeSubDomains`, submit the domain to the HSTS preload list at [https://hstspreload.org](https://hstspreload.org).

## Verification

1. `curl -sI https://chamaconnect.io/` — confirm `strict-transport-security: max-age=63072000; includeSubDomains; preload` is present.
2. `curl -sI https://chamaconnect.io/get-started` — same.
3. `curl -sI https://chamaconnect.io/admin/dashboard` — same.
4. Check [https://hstspreload.org/?domain=chamaconnect.io](https://hstspreload.org/?domain=chamaconnect.io) to confirm preload eligibility.
